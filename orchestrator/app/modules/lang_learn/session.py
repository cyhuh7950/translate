"""
학습 세션 하나의 WebSocket 수명 — DESIGN.md §15 / PLAN_LANG_LEARN.md 그대로의 흐름.

    ready
    → 문제 idx: LLM 이 그 자리에서 생성 (answer_type: repeat | compose)
      - repeat: 문장을 TTS 로 합성해서 오디오도 함께 보낸다
      - compose: 텍스트로 뜻/상황만 제시
    → 사용자 답변 수신 (음성이면 STT, 텍스트면 그대로)
    → LLM 이 평가 (0~100 내부 점수) → 등급(상/중/하) 매핑
    → feedback_mode 에 따라 즉시 전송 여부 결정
    → count 만큼 반복 → 마지막에 feedback_mode 에 따라 총평
    → session.done, 이력 저장

`streaming.py`(번역 모듈)와 달리 여기는 "발화가 언제 끝났는지"를 VAD 로 판단할
필요가 없다 — 한 문제에 답 하나, 턴이 명시적으로 오간다. 그래서 VAD/턴 정책
같은 core 장치를 쓰지 않고 단순한 요청-응답 루프로 짠다. 다듬은 지점과 이유는
아래 각 메서드 주석에 남긴다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from ...core import i18n
from ...core.errors import AppError
from .history_store import LangLearnHistoryStore, ProblemRecord, SessionRecord
from .llm import evaluate_answer, generate_problem, summarize_session
from .settings_store import LangLearnSettingsStore

log = logging.getLogger("lang_learn.session")


class LangLearnError(AppError):
    default_code = "lang_learn.failed"
    default_status = 400


def _grade_for(cfg, score: int) -> str:
    """내부 점수를 등급으로. 프로토콜에는 이 등급만 나간다(점수는 이력에만 남는다)."""
    bands = cfg.get("lang_learn.grade_bands")  # 예: {"상": 80, "중": 50}
    for grade, threshold in sorted(bands.items(), key=lambda kv: -kv[1]):
        if score >= int(threshold):
            return grade
    # 어떤 밴드도 만족하지 못하면 최하 등급. 상/중/하 세 단계는 DESIGN.md §15 가
    # 정한 프로토콜 값 자체라 설정으로 빼지 않았다(밴드 경계는 설정, 등급 이름은
    # 프로토콜 상수).
    return "하"


def _next_level(cfg, levels: list[str], current: str, recent_scores: list[float]) -> str:
    """
    적응형 난이도 — 최근 세션 평균이 상한을 넘으면 한 단계 올리고, 하한 아래면
    내린다. 커밋에 남긴 근거: 이력이 아직 없으면(신규 사용자) 현재 단계를
    그대로 유지한다 — 첫 세션 하나만 보고 단계를 바꾸면 우연히 쉬운/어려운
    문제 하나에 결과가 흔들린다.
    """
    if not recent_scores:
        return current
    avg = sum(recent_scores) / len(recent_scores)
    idx = levels.index(current) if current in levels else 0
    raise_th = float(cfg.get("lang_learn.adaptive.raise_threshold"))
    lower_th = float(cfg.get("lang_learn.adaptive.lower_threshold"))
    if avg >= raise_th and idx < len(levels) - 1:
        idx += 1
    elif avg <= lower_th and idx > 0:
        idx -= 1
    return levels[idx]


@dataclass
class _Options:
    user_id: str
    count: int
    target_lang: str
    level_mode: str
    manual_level: str | None
    feedback_mode: str
    show_text_for_repeat: bool
    level: str = ""
    recent_topics: list[str] = field(default_factory=list)


class LangLearnSession:
    def __init__(
        self,
        ws: WebSocket,
        ctx: Any,
        settings: LangLearnSettingsStore,
        history: LangLearnHistoryStore,
    ):
        self._ws = ws
        self._ctx = ctx
        self._cfg = ctx.config
        self._settings = settings
        self._history = history
        self._locale = i18n.resolve(ws.headers.get("accept-language"))
        self._opts: _Options | None = None
        self._problems: list[ProblemRecord] = []

    # ---- 송신 -------------------------------------------------------------

    async def _send(self, payload: dict, audio: bytes | None = None) -> None:
        if self._ws.client_state is not WebSocketState.CONNECTED:
            return
        await self._ws.send_json(payload)
        if audio is not None:
            await self._ws.send_bytes(audio)

    async def _error(self, error: AppError) -> None:
        log.info("lang_learn error [%s] %s", error.code, error)
        await self._send({
            "type": "error",
            "code": error.code,
            "message": error.message(self._locale),
            "params": error.json_params(),
        })

    # ---- 수명 -------------------------------------------------------------

    async def run(self) -> None:
        await self._ws.accept()
        try:
            await self._start()
            await self._loop()
        except WebSocketDisconnect:
            # 클라이언트가 도중에 끊었다. DESIGN.md §15 의 "세션 종료 시 이력 저장"은
            # **끝까지 마친** 세션을 말한다 — 도중에 끊긴 세션은 저장하지 않는다.
            # 절반만 남은 이력이 적응형 난이도 계산에 잘못 섞이는 것보다,
            # 사용자가 다시 이어서 정식으로 마치게 하는 편이 낫다는 판단이다.
            log.info("lang_learn session disconnected before completion")
        except AppError as exc:
            await self._error(exc)
        finally:
            if self._ws.client_state is WebSocketState.CONNECTED:
                await self._ws.close()

    # ---- 시작 -------------------------------------------------------------

    async def _start(self) -> None:
        timeout = float(self._cfg.get("lang_learn.stream.start_timeout_s"))
        try:
            first = await asyncio.wait_for(self._ws.receive(), timeout=timeout)
        except asyncio.TimeoutError:
            raise LangLearnError("lang_learn.start_timeout", timeout=timeout) from None
        if first.get("type") == "websocket.disconnect":
            raise WebSocketDisconnect(first.get("code", 1000))
        if "text" not in first or first["text"] is None:
            raise LangLearnError("lang_learn.start_required")
        try:
            msg = json.loads(first["text"])
        except ValueError as exc:
            raise LangLearnError("lang_learn.bad_json", reason=exc) from exc
        if not isinstance(msg, dict) or msg.get("type") != "start":
            raise LangLearnError("lang_learn.start_required")

        self._locale = i18n.resolve(msg.get("locale"), self._ws.headers.get("accept-language"))

        user_id = str(msg.get("user_id") or "").strip()
        if not user_id:
            raise LangLearnError("lang_learn.user_required", status=400)
        if self._ctx.users.get(user_id) is None:
            raise LangLearnError("lang_learn.unknown_user", status=404, user_id=user_id)

        settings = self._settings.get(user_id)
        count = int(msg.get("count") or self._cfg.get("lang_learn.stream.default_count"))
        if count <= 0:
            raise LangLearnError("lang_learn.invalid_count", status=400, count=count)

        # 세션 시작 메시지의 값들은 **이 세션 하나에만** 적용되는 일회성 override 다.
        # 저장된 설정을 바꾸려면 PUT /v1/users/{id}/lang_learn/settings 를 쓴다 —
        # WS 세션이 설정 API 를 대신하면 두 경로가 설정을 바꿀 수 있게 되어 어느
        # 쪽이 최종값인지 불분명해진다.
        target_lang = str(msg.get("target_lang") or settings["target_lang"])
        feedback_mode = str(msg.get("feedback_mode") or settings["feedback_mode"])
        level_mode = str(msg.get("level_mode") or settings["level_mode"])
        manual_level = msg.get("manual_level", settings["manual_level"])
        show_text_for_repeat = bool(
            msg.get("show_text_for_repeat", settings["show_text_for_repeat"])
        )

        levels = list(self._cfg.get("lang_learn.levels"))
        if level_mode == "manual":
            level = manual_level or self._cfg.get("lang_learn.default_level")
            if level not in levels:
                raise LangLearnError(
                    "lang_learn.invalid_level", status=400, level=level,
                    available=", ".join(levels),
                )
        else:
            level = self._settings.get_adaptive_level(user_id) or self._cfg.get(
                "lang_learn.default_level"
            )

        self._opts = _Options(
            user_id=user_id,
            count=count,
            target_lang=target_lang,
            level_mode=level_mode,
            manual_level=manual_level,
            feedback_mode=feedback_mode,
            show_text_for_repeat=show_text_for_repeat,
            level=level,
        )

        await self._send({
            "type": "ready",
            "total": count,
            "target_lang": target_lang,
            "level": level,
            "feedback_mode": feedback_mode,
        })

    # ---- 문제 루프 ---------------------------------------------------------

    async def _loop(self) -> None:
        opts = self._opts
        assert opts is not None
        pattern = list(self._cfg.get("lang_learn.answer_type_pattern"))
        if not pattern:
            raise LangLearnError("lang_learn.no_answer_type_pattern")

        for idx in range(opts.count):
            answer_type = pattern[idx % len(pattern)]
            problem_text = await generate_problem(
                self._ctx,
                target_lang=opts.target_lang,
                learner_lang=self._locale,
                level=opts.level,
                answer_type=answer_type,
                recent_topics=opts.recent_topics,
            )
            opts.recent_topics.append(problem_text)
            del opts.recent_topics[:-5]  # 최근 5개만 "피할 주제"로 넘긴다 — 그 이상은 의미가 옅다

            audio_bytes: bytes | None = None
            if answer_type == "repeat":
                speech = await self._ctx.speech.to_audio(
                    mode=self._cfg.get("lang_learn.tts_mode"),
                    text=problem_text,
                    language=opts.target_lang,
                    speed=float(self._cfg.get("audio.tts_speed")),
                    response_format=self._cfg.get("audio.tts_response_format"),
                )
                audio_bytes = speech.audio

            await self._send(
                {
                    "type": "problem",
                    "idx": idx,
                    "total": opts.count,
                    "answer_type": answer_type,
                    "text": problem_text,
                    "audio_hint": audio_bytes is not None,
                },
                audio=audio_bytes,
            )

            answer_text, captured_audio, content_type, duration_s = await self._receive_answer(idx)
            await self._send({"type": "answer.received", "idx": idx})

            if captured_audio is not None:
                self._maybe_capture_voice_sample(
                    opts.user_id, captured_audio, content_type, duration_s
                )

            score, comment = await evaluate_answer(
                self._ctx,
                target_lang=opts.target_lang,
                learner_lang=self._locale,
                level=opts.level,
                answer_type=answer_type,
                problem_text=problem_text,
                answer_text=answer_text,
            )
            grade = _grade_for(self._cfg, score)
            self._problems.append(
                ProblemRecord(
                    idx=idx, answer_type=answer_type, problem_text=problem_text,
                    answer_text=answer_text, score=score, grade=grade, comment=comment,
                )
            )

            if opts.feedback_mode in ("immediate", "both"):
                await self._send({"type": "feedback", "idx": idx, "grade": grade, "comment": comment})

        await self._finish()

    async def _receive_answer(self, idx: int) -> tuple[str, bytes | None, str, float]:
        """
        답변 하나를 받는다. 텍스트면 그대로, 음성이면 STT 를 거친다.

        오디오는 프로토콜상 두 프레임이다 — 먼저 `{"type":"answer","modality":"audio",...}`,
        곧이어 오디오 바이너리. `streaming.py` 의 tts.chunk 가 오디오를 JSON 뒤에
        붙이는 것과 같은 관례를 답변 쪽에도 그대로 적용한 것이다.
        """
        timeout = float(self._cfg.get("lang_learn.stream.answer_timeout_s"))
        try:
            first = await asyncio.wait_for(self._ws.receive(), timeout=timeout)
        except asyncio.TimeoutError:
            raise LangLearnError("lang_learn.answer_timeout", timeout=timeout, idx=idx) from None
        if first.get("type") == "websocket.disconnect":
            raise WebSocketDisconnect(first.get("code", 1000))
        if "text" not in first or first["text"] is None:
            raise LangLearnError("lang_learn.answer_required", idx=idx)
        try:
            msg = json.loads(first["text"])
        except ValueError as exc:
            raise LangLearnError("lang_learn.bad_json", reason=exc) from exc
        if not isinstance(msg, dict) or msg.get("type") != "answer" or msg.get("idx") != idx:
            raise LangLearnError("lang_learn.answer_required", idx=idx)

        modality = msg.get("modality", "text")
        if modality == "text":
            return str(msg.get("text") or ""), None, "", 0.0

        if modality != "audio":
            raise LangLearnError("lang_learn.unknown_modality", modality=modality)

        content_type = str(msg.get("content_type") or self._cfg.get("stream.segment_content_type"))
        duration_s = float(msg.get("duration_s") or 0.0)
        try:
            second = await asyncio.wait_for(self._ws.receive(), timeout=timeout)
        except asyncio.TimeoutError:
            raise LangLearnError("lang_learn.answer_timeout", timeout=timeout, idx=idx) from None
        if second.get("type") == "websocket.disconnect":
            raise WebSocketDisconnect(second.get("code", 1000))
        audio = second.get("bytes")
        if not audio:
            raise LangLearnError("lang_learn.audio_required", idx=idx)

        opts = self._opts
        assert opts is not None
        transcript = await self._ctx.speech.to_text(
            mode=self._cfg.get("lang_learn.stt_mode"),
            audio=audio,
            filename=self._cfg.get("stream.segment_filename"),
            content_type=content_type,
            language=opts.target_lang,
        )
        if not duration_s and transcript.duration:
            duration_s = float(transcript.duration)
        return transcript.text, audio, content_type, duration_s

    def _maybe_capture_voice_sample(
        self, user_id: str, audio: bytes, content_type: str, duration_s: float
    ) -> None:
        """
        STT 개인화 저장소 배선 (PLAN_LANG_LEARN.md 서버 작업 4번).

        전부 저장하지 않는 이유와 비율은 defaults.yaml 의
        `lang_learn.voice_sample_capture_rate` 주석에 적었다. 저장 실패는 학습
        세션을 막지 않는다 — 이건 부가 기능이라 실패해도 사용자가 지금 하는
        학습에는 영향이 없어야 한다.
        """
        rate = float(self._cfg.get("lang_learn.voice_sample_capture_rate"))
        if rate <= 0 or random.random() >= rate:
            return
        try:
            self._ctx.voice_samples.save(
                user_id=user_id,
                audio=audio,
                content_type=content_type or "application/octet-stream",
                duration_s=duration_s,
                source="lang_learn_session",
            )
        except AppError as exc:
            log.warning("Could not save a voice sample from a lang_learn session: %s", exc)

    # ---- 종료 -------------------------------------------------------------

    async def _finish(self) -> None:
        opts = self._opts
        assert opts is not None

        summary_score: int | None = None
        summary_grade: str | None = None
        summary_comment: str | None = None
        if opts.feedback_mode in ("summary", "both"):
            transcript = "\n\n".join(
                f"Problem {p.idx + 1} ({p.answer_type}): {p.problem_text}\n"
                f"Answer: {p.answer_text}\nScore: {p.score}/100"
                for p in self._problems
            )
            summary_score, summary_comment = await summarize_session(
                self._ctx,
                target_lang=opts.target_lang,
                learner_lang=self._locale,
                level=opts.level,
                transcript=transcript,
            )
            summary_grade = _grade_for(self._cfg, summary_score)
            await self._send({"type": "session.summary", "grade": summary_grade, "comment": summary_comment})

        record = SessionRecord(
            id=self._history.new_id(),
            user_id=opts.user_id,
            created_at=_iso_now(),
            target_lang=opts.target_lang,
            level=opts.level,
            feedback_mode=opts.feedback_mode,
            problems=list(self._problems),
            summary_score=summary_score,
            summary_grade=summary_grade,
            summary_comment=summary_comment,
        )
        self._history.save(record)

        if opts.level_mode == "adaptive":
            levels = list(self._cfg.get("lang_learn.levels"))
            lookback = int(self._cfg.get("lang_learn.adaptive.lookback_sessions"))
            recent = self._history.recent_scores(user_id=opts.user_id, limit=lookback)
            new_level = _next_level(self._cfg, levels, opts.level, recent)
            self._settings.set_adaptive_level(opts.user_id, new_level)

        await self._send({"type": "session.done"})


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")
