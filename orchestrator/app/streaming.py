"""
WebSocket 스트리밍 세션 — VAD 로 발화를 잘라 세그먼트 단위로 파이프라인을 돌린다.

1단계 ⑤. 아직 스트리밍 STT 엔진이 없으므로(2단계) 세그먼트가 확정되면 그 구간을
WAV 로 감싸 **기존 배치 파이프라인을 그대로** 호출한다. 파이프라인 로직은 여기 없다.

이렇게 해서 얻는 것은 지연이다. PTT 는 버튼을 누르고 있는 동안 전부 녹음돼서
(실측 10.74초 녹음에 실제 발화 2초) 무음까지 인식에 들어갔다. VAD 가 앞뒤 무음을
버리면 STT 에 들어가는 오디오가 그만큼 줄고, STT 는 무음도 같은 속도로 처리하므로
줄어든 만큼 그대로 시간이 준다.

프로토콜은 DESIGN.md "API 규격" 을 따른다.

  클라이언트 → 서버
    {"type":"config", ...}                      최초 1회
    <바이너리>                                   PCM16 mono, audio.stt_sample_rate
    {"type":"control","action":"flush"}         강제 세그먼트 확정
    {"type":"control","action":"cancel"}        진행 중인 것 취소
    {"type":"control","action":"playback", "state":"start"|"end"}
                                                재생 상태 보정 (턴 정책용, 선택)

  서버 → 클라이언트
    ready / vad / stt.final / llm.final / tts.chunk(+바이너리) / tts.done / metrics / error
    speaker.rejected                            등록되지 않은 목소리라 건너뛴 세그먼트

`speaker.rejected` 는 오류가 아니다. 화자 식별이 이 발화를 처리하지 않기로 한 것이고,
같은 사유가 뒤따르는 metrics 이벤트의 `skipped` 에도 실린다.

`stt.partial` 과 `llm.delta` 는 스트리밍 엔진이 없어 지금 나가지 않는다.
**프로토콜에서 빼지는 않는다** — 2단계에서 같은 자리에 채운다.

from/to 규약
------------
모든 이벤트에 `from` 과 `to` 가 붙는다. 단방향에서도 마찬가지다.
타입만 다르다 — 수신자 하나에 대한 이벤트(llm.*, tts.*)의 `to` 는 문자열이고,
발화자 쪽 이벤트(vad, stt.*, ready)의 `to` 는 수신자 id **배열**이다.
다중 기기 토폴로지에서 클라이언트는 자기 id 가 `to` 에 들어 있는 것만 보면 된다.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

import numpy as np
from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from . import diagnostics, preprocess, registry
from .adapters.llm._base import LLMError
from .adapters.speaker_id._base import SpeakerIdError, static_speaker
from .adapters.turn.policies import STOP_OUTPUT, TURN_KIND, TurnState
from .adapters.vad._base import SPEECH_END, SPEECH_START, VAD_KIND, VadError
from .audio import duration_s, pcm16_from_bytes, pcm16_to_wav
from .config import ConfigError
from .engines import EngineError
from .llm import Turn
from .registry import RegistryError
from .sessions import SessionError
from .voiceprints import SessionVoices

log = logging.getLogger("stream")


class StreamError(Exception):
    """클라이언트에 code 와 함께 돌려줄 오류. 메시지는 영어(기본어)로 쓴다."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class _Segment:
    seg: int
    pcm: np.ndarray
    speech_ms: int
    reason: str
    # VAD 가 본 스트림상의 위치(ms). 진단 사이드카에만 쓰인다 —
    # 저장된 오디오 길이와 비교하면 앞뒤로 얼마가 잘렸는지가 드러난다.
    start_ms: int = 0
    end_ms: int = 0


class StreamHandler:
    """
    WS 연결 하나의 수명을 관리한다.

    수신 루프와 처리 워커를 분리한다. 처리(STT→LLM→TTS)는 CPU 엔진에서 수초가
    걸리므로 수신 루프에서 await 하면 그동안 들어온 오디오가 소켓 버퍼에 쌓인다.
    워커를 하나만 두는 이유는 세그먼트 순서를 보장하기 위해서다.
    """

    def __init__(self, ws: WebSocket, ctx: Any):
        self._ws = ws
        self._ctx = ctx                      # server.State
        self._cfg = ctx.config

        self._session = None                 # sessions.Session
        self._vad = None
        self._turn = None
        # 세션 중 자동으로 배운 목소리. **메모리에만 있고 연결이 끊기면 함께 사라진다.**
        # WS 세션은 "처음 나온 목소리"라는 개념이 성립하므로 자동 등록이 여기에 붙는다.
        self._voices = None                  # voiceprints.SessionVoices
        self._turn_state = TurnState()
        self._deliver_until = 0.0            # 재생 중이라고 볼 시각 (loop.time 기준)

        self._sample_rate = 0
        self._channels = 0
        self._options: dict[str, Any] = {}
        self._context: dict[tuple[str, str], list[Turn]] = {}

        self._queue: asyncio.Queue[_Segment] = asyncio.Queue()
        self._seg = 0
        self._speech_start_ms = 0            # 마지막 speech_start 위치 (진단용)
        self._send_lock = asyncio.Lock()
        self._worker: asyncio.Task | None = None
        self._current: asyncio.Task | None = None
        self._closing = False

    # ---- 송신 -------------------------------------------------------------

    async def _send(self, payload: dict, audio: bytes | None = None) -> None:
        """
        JSON 이벤트를, 필요하면 바로 뒤에 바이너리 프레임을 붙여 보낸다.

        락으로 묶는 이유는 tts.chunk 와 그 오디오 사이에 다른 이벤트가 끼면
        클라이언트가 어느 chunk 의 오디오인지 알 수 없기 때문이다.
        """
        if self._ws.client_state is not WebSocketState.CONNECTED:
            return
        async with self._send_lock:
            await self._ws.send_json(payload)
            if audio is not None:
                await self._ws.send_bytes(audio)

    async def _error(self, code: str, message: str) -> None:
        log.info("stream error [%s] %s", code, message)
        await self._send({"type": "error", "code": code, "message": message, **self._route()})

    def _route(self) -> dict:
        """
        발화자 쪽 이벤트에 붙는 from/to. 세션이 아직 없거나 정할 수 없으면 비어 있다.

        여기서는 **오디오를 보지 않는 판정만** 쓴다(hint 이거나 후보가 하나뿐인 경우).
        vad·ready·error 는 오디오가 확정되기 전에도 나가는 이벤트라, 이것 하나 붙이자고
        화자 임베딩 엔진을 부를 수는 없기 때문이다. 실제 발화자는 세그먼트가 처리될 때
        파이프라인이 정하고, 그 결과가 stt.final 이후의 이벤트에 실린다.
        """
        if self._session is None:
            return {}
        try:
            speaker = self._speaker_id()
            if speaker is None:
                return {}
            return {"from": speaker, "to": [p.id for p in self._session.listeners_of(speaker)]}
        except Exception:
            # 오류 이벤트를 보내려다 다시 죽으면 안 된다. 그 이유는 error 로 이미 나간다.
            return {}

    # ---- 수명 -------------------------------------------------------------

    async def run(self) -> None:
        await self._ws.accept()
        try:
            await self._configure()
        except StreamError as exc:
            await self._error(exc.code, str(exc))
            await self._ws.close()
            return

        self._worker = asyncio.create_task(self._run_worker())
        try:
            await self._receive_loop()
        except WebSocketDisconnect:
            pass
        finally:
            await self._shutdown()

    async def _shutdown(self) -> None:
        self._closing = True
        for task in (self._current, self._worker):
            if task and not task.done():
                task.cancel()
        if self._worker:
            await asyncio.gather(self._worker, return_exceptions=True)
        if self._ws.client_state is WebSocketState.CONNECTED:
            await self._ws.close()

    # ---- 설정 -------------------------------------------------------------

    async def _configure(self) -> None:
        timeout = float(self._cfg.get("stream.config_timeout_s"))
        try:
            first = await asyncio.wait_for(self._ws.receive(), timeout=timeout)
        except asyncio.TimeoutError:
            raise StreamError(
                "stream.config_timeout",
                f"No config message within {timeout}s. Send "
                f'{{"type":"config", ...}} first',
            ) from None

        if first.get("type") == "websocket.disconnect":
            raise WebSocketDisconnect(first.get("code", 1000))
        if "text" not in first or first["text"] is None:
            raise StreamError(
                "stream.config_required",
                'The first message must be a JSON {"type":"config", ...}, not binary audio',
            )

        try:
            msg = json.loads(first["text"])
        except ValueError as exc:
            raise StreamError("stream.bad_json", f"Could not parse the config message: {exc}")
        if not isinstance(msg, dict) or msg.get("type") != "config":
            raise StreamError(
                "stream.config_required",
                'The first message must have "type":"config"',
            )

        self._sample_rate = int(self._cfg.get("audio.stt_sample_rate"))
        self._channels = int(self._cfg.get("audio.stt_channels"))
        declared = msg.get("sample_rate")
        if declared is not None and int(declared) != self._sample_rate:
            # 리샘플링을 조용히 해주지 않는다. 클라이언트가 /v1/config 를 보고
            # 맞춰 보내야 어디서 어긋났는지가 드러난다.
            raise StreamError(
                "stream.sample_rate",
                f"This server expects PCM16 mono at {self._sample_rate} Hz "
                f"(audio.stt_sample_rate), but the client declared {declared}",
            )

        source_lang = (msg.get("source_lang") or "").strip()
        target_lang = (msg.get("target_lang") or "").strip()
        if not source_lang or not target_lang:
            raise StreamError(
                "stream.language_required", "config must include source_lang and target_lang"
            )

        try:
            self._session = self._ctx.profiles.create(
                profile=msg.get("profile"),
                mode=msg.get("mode"),
                source_lang=source_lang,
                target_lang=target_lang,
                participants=msg.get("participants"),
            )
        except (SessionError, ConfigError) as exc:
            raise StreamError("session.invalid", str(exc)) from exc

        try:
            vad_settings = self._cfg.require_section("vad")
            backend = self._cfg.get("vad.backend")
            self._vad = registry.resolve(VAD_KIND, backend)(vad_settings, self._sample_rate)
            self._turn = registry.resolve(TURN_KIND, self._session.turn_policy)(
                self._cfg.require_section("turn")
            )
            self._voices = SessionVoices(self._cfg.get("speaker_id.auto_enroll.utterances"))
        except (RegistryError, VadError, ConfigError) as exc:
            raise StreamError("stream.setup_failed", str(exc)) from exc

        # 파이프라인에 그대로 넘길 값들. 없는 것은 넣지 않아야 서버 기본값이 쓰인다.
        self._options = {
            "speaker_hint": msg.get("speaker"),
            "stt_engine": msg.get("stt_engine") or None,
            "tts_engine": msg.get("tts_engine") or None,
            "voice": msg.get("voice") or None,
            "speed": float(
                msg["speed"] if msg.get("speed") is not None else self._cfg.get("audio.tts_speed")
            ),
            "response_format": msg.get("response_format") or self._cfg.get(
                "audio.tts_response_format"
            ),
            "provider": msg.get("provider") or None,
            "model": msg.get("model") or None,
            "style": msg.get("style") or None,
            "glossary": msg.get("glossary") or None,
            "with_audio": bool(msg.get("with_audio", True)),
        }

        await self._send({
            "type": "ready",
            "session_id": str(id(self)),
            "participants": [p.as_dict() for p in self._session.participants],
            "profile": self._session.profile,
            "mode": self._session.mode,
            "turn_policy": self._session.turn_policy,
            "audio": {
                "sample_rate": self._sample_rate,
                "channels": self._channels,
                "format": self._cfg.get("stream.input_format"),
                "frame_ms": self._cfg.get("stream.client_frame_ms"),
            },
            "vad": {"backend": self._cfg.get("vad.backend")},
            **self._route(),
        })

    def _speaker_id(self) -> str | None:
        """오디오 없이 알 수 있는 발화자. 단방향은 후보가 하나라 hint 없이 정해진다."""
        return static_speaker(
            [p.as_dict() for p in self._session.participants],
            self._options.get("speaker_hint"),
        )

    # ---- 수신 -------------------------------------------------------------

    async def _receive_loop(self) -> None:
        while True:
            message = await self._ws.receive()
            kind = message.get("type")
            if kind == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                await self._on_audio(message["bytes"])
            elif message.get("text") is not None:
                await self._on_text(message["text"])

    async def _on_text(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError as exc:
            await self._error("stream.bad_json", f"Could not parse the message: {exc}")
            return
        if not isinstance(msg, dict):
            await self._error("stream.bad_message", "A message must be a JSON object")
            return

        kind = msg.get("type")
        if kind == "config":
            await self._error(
                "stream.already_configured",
                "This session is already configured. Open a new connection to change it",
            )
            return
        if kind != "control":
            await self._error("stream.unknown_message", f"Unknown message type: '{kind}'")
            return

        action = msg.get("action")
        if action == "flush":
            await self._drain_vad(force=True)
        elif action == "cancel":
            await self._cancel()
        elif action == "playback":
            # 클라이언트가 실제 재생 상태를 알려주면 서버의 추정을 보정한다.
            playing = msg.get("state") == "start"
            self._turn_state.delivering = playing
            self._deliver_until = 0.0
        else:
            await self._error("stream.unknown_action", f"Unknown control action: '{action}'")

    async def _on_audio(self, data: bytes) -> None:
        if self._vad is None:
            return

        self._refresh_turn_state()
        if not self._turn.accepts_audio(self._turn_state):
            # half_duplex — 번역 음성이 나가는 동안 들어온 것은 버린다.
            # 스피커 소리가 마이크로 되돌아와 자기 번역을 다시 번역하는 루프를 막는다.
            return

        try:
            events = self._vad.push(pcm16_from_bytes(data))
        except Exception as exc:
            await self._error("vad.failed", f"{type(exc).__name__}: {exc}")
            return
        await self._emit_vad(events)

    async def _drain_vad(self, *, force: bool) -> None:
        if self._vad is None:
            return
        events = self._vad.flush()
        if force:
            for e in events:
                e.reason = "forced"
        await self._emit_vad(events)

    async def _emit_vad(self, events) -> None:
        route = self._route()
        for event in events:
            await self._send({"type": "vad", **event.meta(), **route})
            if event.state == SPEECH_START:
                self._speech_start_ms = event.at_ms
                action = self._turn.on_speech_start(self._turn_state)
                if action == STOP_OUTPUT:
                    await self._send({"type": "tts.stop", **route})
                    self._turn_state.delivering = False
                    self._deliver_until = 0.0
            elif event.state == SPEECH_END and not event.dropped and event.audio is not None:
                self._seg += 1
                await self._queue.put(
                    _Segment(
                        seg=self._seg,
                        pcm=event.audio,
                        speech_ms=event.speech_ms or 0,
                        reason=event.reason or "silence",
                        start_ms=self._speech_start_ms,
                        end_ms=event.at_ms,
                    )
                )

    async def _cancel(self) -> None:
        """진행 중인 세그먼트를 버리고 큐를 비운다. VAD 상태도 초기화한다."""
        if self._current and not self._current.done():
            self._current.cancel()
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except asyncio.QueueEmpty:
                break
        if self._vad is not None:
            self._vad.flush()
        self._turn_state.delivering = False
        self._deliver_until = 0.0
        await self._send({"type": "cancelled", **self._route()})

    def _refresh_turn_state(self) -> None:
        if self._deliver_until:
            if asyncio.get_running_loop().time() >= self._deliver_until:
                self._deliver_until = 0.0
                self._turn_state.delivering = False
        self._turn_state.processing = self._current is not None and not self._current.done()

    # ---- 처리 -------------------------------------------------------------

    async def _run_worker(self) -> None:
        while True:
            segment = await self._queue.get()
            self._current = asyncio.create_task(self._process(segment))
            try:
                await self._current
            except asyncio.CancelledError:
                if self._closing:
                    raise
                # cancel 액션으로 이 세그먼트만 죽인 경우. 다음 것을 계속 받는다.
            except Exception as exc:
                log.exception("Segment processing failed")
                await self._error("pipeline.failed", f"{type(exc).__name__}: {exc}")
            finally:
                self._current = None
                self._queue.task_done()

    async def _process(self, segment: _Segment) -> None:
        loop = asyncio.get_running_loop()
        started = loop.time()

        # 배경 음성 게이트. VAD 가 경계를 옳게 잡아도 세그먼트 **안쪽**의 휴지 구간에
        # 남은 TV·옆사람 소리는 그대로 STT 로 넘어간다. 그것을 여기서 지운다.
        # PTT(HTTP 업로드)와 같은 구현을 쓴다 — app/preprocess.py 를 볼 것.
        # 길이는 바뀌지 않으므로 아래 시간 계산과 진단 사이드카의 시간축은 그대로다.
        pcm, gate_metrics = preprocess.filter_pcm(self._cfg, segment.pcm, self._sample_rate)

        wav = pcm16_to_wav(pcm, sample_rate=self._sample_rate, channels=self._channels)
        seg_seconds = duration_s(pcm.size, self._sample_rate)

        async def progress(stage: str, payload: dict) -> None:
            await self._on_stage(stage, payload)

        result = None
        failure: tuple[str, str] | None = None
        try:
            result = await self._ctx.pipeline.run_audio(
                self._session,
                audio=wav,
                filename=self._cfg.get("stream.segment_filename"),
                content_type=self._cfg.get("stream.segment_content_type"),
                seg=segment.seg,
                context=self._context_for(),
                progress=progress,
                voices=self._voices,
                **self._options,
            )
        except (SessionError, SpeakerIdError) as exc:
            failure = ("session.invalid", str(exc))
        except (EngineError, LLMError) as exc:
            failure = ("engine.failed", str(exc))
        except RegistryError as exc:
            failure = ("registry.failed", str(exc))
        finally:
            # 진단 덤프. 꺼져 있으면 아무 일도 하지 않는다.
            # 오류로 끝난 세그먼트야말로 들어봐야 하므로 finally 에 둔다.
            self._dump_segment(
                segment, wav, seg_seconds, result, failure,
                elapsed_ms=round((loop.time() - started) * 1000),
                gate_metrics=gate_metrics,
            )

        # 오류 통지는 덤프 뒤로 미룬다. 클라이언트에 보내는 내용과 시점은 그대로다.
        if failure is not None:
            await self._error(*failure)
            return

        # 대화 맥락 축적. 한국어는 주어 생략이 많아 맥락 없이는 대명사를 틀린다.
        limit = int(self._cfg.get("llm.context_turns"))
        for delivery in result.deliveries:
            if not (result.source_text and delivery.text):
                continue
            key = (result.speaker, delivery.to)
            turns = self._context.setdefault(key, [])
            turns.append(Turn(source=result.source_text, target=delivery.text))
            if limit > 0:
                del turns[:-limit]

        metrics = dict(result.metrics)
        metrics.update(gate_metrics)
        metrics["segment_ms"] = round(seg_seconds * 1000)
        metrics["vad_speech_ms"] = segment.speech_ms
        metrics["segment_reason"] = segment.reason
        metrics["pipeline_ms"] = round((loop.time() - started) * 1000)
        await self._send({
            "type": "metrics",
            "seg": segment.seg,
            **metrics,
            "from": result.speaker,
            "to": [d.to for d in result.deliveries],
        })

    # ---- 진단 -------------------------------------------------------------

    def _dump_segment(
        self,
        segment: _Segment,
        wav: bytes,
        seg_seconds: float,
        result: Any,
        failure: tuple[str, str] | None,
        *,
        elapsed_ms: int,
        gate_metrics: dict,
    ) -> None:
        """
        VAD 가 잘라 STT 로 보낸 오디오를 그대로 디스크에 남긴다 (기본값: 꺼짐).

        진단이 서비스를 멈추면 안 되므로 여기서 나는 모든 예외를 삼킨다. 설정이
        빠진 경우도 마찬가지다 — 그때는 무엇을 채워야 하는지가 ConfigError 메시지에
        그대로 들어 있으니 경고 로그로 충분하다.

        저장 내용은 `diagnostics.py` 와 defaults.yaml 의 `diagnostics:` 를 볼 것.
        **켜면 사용자 음성이 디스크에 남는다.**
        """
        try:
            if not self._cfg.get("diagnostics.save_segments"):
                return

            duration_ms = round(seg_seconds * 1000)
            record: dict[str, Any] = {
                "seg": segment.seg,
                "session_id": str(id(self)),
                "audio": {
                    "sample_rate": self._sample_rate,
                    "channels": self._channels,
                    "duration_ms": duration_ms,
                    "bytes": len(wav),
                },
                # start_ms/end_ms 는 스트림 시작 기준이고 duration_ms 는 저장된 길이다.
                # (end_ms - start_ms) 와 duration_ms 의 차이가 곧 꼬리에서 버린 무음이다.
                "vad": {
                    "backend": self._cfg.get("vad.backend"),
                    "start_ms": segment.start_ms,
                    "end_ms": segment.end_ms,
                    "span_ms": max(0, segment.end_ms - segment.start_ms),
                    "speech_ms": segment.speech_ms,
                    "reason": segment.reason,
                    "settings": self._cfg.get("vad"),
                },
                "session": {
                    "profile": self._session.profile if self._session else None,
                    "mode": self._session.mode if self._session else None,
                    "turn_policy": self._session.turn_policy if self._session else None,
                },
                # 게이트를 거친 뒤의 오디오가 저장된다. STT 가 실제로 받은 것을
                # 들어봐야 하므로 그 편이 맞다. 얼마나 잘렸는지는 gate_* 지표에 있다.
                "audio_filter": {
                    "enabled": self._cfg.get("audio_filter.enabled"),
                    "implementation": self._cfg.get("audio_filter.implementation"),
                    "settings": self._cfg.get("audio_filter"),
                },
                "metrics": {"pipeline_ms": elapsed_ms, **gate_metrics},
                "error": None,
            }
            if failure is not None:
                record["error"] = {"code": failure[0], "message": failure[1]}
            if result is not None:
                record["stt"] = {"text": result.source_text, "lang": result.source_lang}
                record["engines"] = dict(result.engines)
                record["translations"] = [
                    {
                        "to": d.to,
                        "lang": d.lang,
                        "text": d.text,
                        "tts_duration_s": d.duration,
                        "tts_bytes": len(d.audio) if d.audio else 0,
                    }
                    for d in result.deliveries
                ]
                record["metrics"].update(result.metrics)

            path = diagnostics.save_segment(
                self._cfg,
                wav=wav,
                seg=segment.seg,
                duration_ms=duration_ms,
                label=result.source_text if result is not None else "",
                record=record,
            )
            log.info("Saved diagnostic segment: %s", path)
        except Exception as exc:
            log.warning(
                "Could not save the diagnostic segment dump: %s: %s", type(exc).__name__, exc
            )

    def _context_for(self) -> list[Turn]:
        """
        LLM 에 넘길 맥락.

        참여자 쌍마다 따로 쌓아두지만, 파이프라인은 세그먼트당 한 벌만 받는다.
        단방향에서는 쌍이 하나뿐이라 그대로 맞고, 2단계에서 방향별 맥락이 필요해지면
        파이프라인이 수신자별로 골라 쓰도록 바꾸면 된다.
        """
        if not self._context:
            return []
        return next(iter(self._context.values()))

    async def _on_stage(self, stage: str, payload: dict) -> None:
        """
        파이프라인이 단계마다 부르는 콜백. 여기서 WS 이벤트로 바꾼다.

        파이프라인을 복제하지 않고도 결과를 흘려보내기 위한 통로다.
        2단계에서 stt.partial / llm.delta 가 생기면 같은 통로로 들어온다.
        """
        if stage == "stt.final":
            await self._send({"type": "stt.final", **payload, "to": self._route().get("to", [])})
            return

        if stage == "llm.final":
            await self._send({"type": "llm.final", **payload})
            return

        if stage == "tts.final":
            audio = payload.pop("audio", None)
            seq = payload.pop("seq", 0)
            if audio:
                await self._send({"type": "tts.chunk", "seq": seq, **payload}, audio=audio)
                self._mark_delivering(payload.get("duration"))
            await self._send({
                "type": "tts.done",
                "seg": payload.get("seg"),
                "from": payload.get("from"),
                "to": payload.get("to"),
            })
            return

        # 모르는 단계는 그대로 흘려보낸다. 2단계에서 단계가 늘어도 여기를 고치지 않게.
        await self._send({"type": stage, **payload})

    def _mark_delivering(self, duration: float | None) -> None:
        """
        서버는 스피커를 볼 수 없으므로 보낸 오디오 길이로 재생 구간을 추정한다.
        클라이언트가 control/playback 을 보내주면 그 값이 이 추정을 덮는다.
        """
        if not duration:
            return
        grace = float(self._cfg.get("turn.playback_grace_s"))
        self._turn_state.delivering = True
        self._deliver_until = asyncio.get_running_loop().time() + float(duration) + grace
