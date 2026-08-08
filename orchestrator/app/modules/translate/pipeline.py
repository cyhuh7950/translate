"""
번역 파이프라인 — STT → (화자 식별) → LLM → TTS.

**흐름만 여기 있다.** 화자 식별·STT·TTS 를 실제로 부르는 일은 `core/speech.py` 가 한다 —
문서 음성화·외국어 학습·음성 대화도 같은 단계를 쓰기 때문이다. 이 파일에 남은 것은
번역에만 있는 것들이다: 원문을 확정하는 두 입구, 수신자별 fan-out, 그때의 metrics.

입력이 오디오냐 텍스트냐
------------------------
들어오는 것만 다르고 뒷부분은 같다. 그래서 흐름을 둘로 나누지 않고 **앞부분만** 나눈다.

    run_audio()  화자 식별 → STT ─┐
                                  ├─▶ _deliver()  수신자별 번역 → TTS
    run_text()   화자 식별 ───────┘

`_deliver()` 가 유일한 번역·합성 경로다. 온디바이스 STT 를 쓰는 클라이언트가
텍스트를 보내도 같은 규칙(방향 계산, from/to, metrics, progress 이벤트)이 적용된다.

1단계는 배치/PTT 이지만 구조는 최종 목표(실시간 양방향)에 맞춰져 있다.

  - 세션은 참여자 목록을 갖고, 번역 방향은 **발화자 언어 → 수신자 언어**로 계산된다.
    코드에 "ko→en" 같은 상수가 없다.
  - 결과에는 항상 `from` / `to` 참여자 id 가 붙는다. 단방향에서도 마찬가지다.
    이 필드가 처음부터 있어야 양방향으로 갈 때 프로토콜을 깨지 않는다.
  - 처리 단위는 발화 전체가 아니라 **세그먼트**다. 지금은 세그먼트가 하나뿐이지만
    스트리밍으로 갈 때 이 경계가 그대로 쓰인다.

세그먼트를 건너뛰는 두 가지
---------------------------
둘 다 오류가 아니라 정상적인 결과다. 예외를 던지지 않고 빈 결과를 돌려주며,
`metrics.skipped` 에 사유가 남는다.

    인식된 텍스트가 없다   무음이거나 STT 가 아무것도 못 알아들었다
    화자가 거부됐다        등록되지 않은 목소리(옆 사람·TV)로 판정됐다
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from ...core.engines import Engine
from ...core.llm import Translator, Turn
from ...core.sessions import Session
from ...core.speech import STT_KIND, TTS_KIND, SpeechService
from ...core.voiceprints import SessionVoices

log = logging.getLogger("pipeline")

# 단계가 끝날 때마다 부르는 콜백. WS 스트림이 결과를 기다리지 않고 흘려보내는 통로다.
#   progress(stage, payload)
#     stage = "speaker.rejected" | "stt.final" | "llm.final" | "tts.final"
# HTTP 경로는 넘기지 않으므로 동작이 그대로다. 2단계에서 stt.partial / llm.delta 가
# 생기면 같은 통로에 stage 를 하나 더 얹는다 — 호출자는 고치지 않는다.
Progress = Callable[[str, dict], Awaitable[None]]


class PipelineError(Exception):
    pass


@dataclass
class Delivery:
    """한 수신자에게 갈 번역 결과."""
    to: str
    lang: str
    text: str
    audio: bytes | None = None
    content_type: str | None = None
    sample_rate: int | None = None
    duration: float | None = None

    def meta(self) -> dict:
        return {
            "to": self.to,
            "lang": self.lang,
            "text": self.text,
            "content_type": self.content_type,
            "sample_rate": self.sample_rate,
            "duration": self.duration,
            "audio_bytes": len(self.audio) if self.audio else 0,
        }


@dataclass
class Outputs:
    """
    번역·합성 단계가 요청에서 받는 값들.

    입력 경로(오디오/텍스트)가 늘어도 이 묶음은 그대로다. 뒷단이 필요로 하는 것을
    한 곳에 모아 두면 새 입력 경로를 붙일 때 인자 목록을 다시 베끼지 않아도 된다.
    """

    speed: float
    response_format: str
    tts_engine: str | None = None
    voice: str | None = None
    provider: str | None = None
    model: str | None = None
    style: str | None = None
    context: list[Turn] | None = None
    glossary: dict[str, str] | None = None
    with_audio: bool = True


@dataclass
class SegmentResult:
    seg: int
    speaker: str
    source_lang: str
    source_text: str
    deliveries: list[Delivery] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    engines: dict[str, str] = field(default_factory=dict)

    def meta(self) -> dict:
        return {
            "seg": self.seg,
            "from": self.speaker,
            "source_lang": self.source_lang,
            "source_text": self.source_text,
            "deliveries": [d.meta() for d in self.deliveries],
            "engines": self.engines,
            "metrics": self.metrics,
        }


class Pipeline:
    """
    번역 고유의 흐름만 갖는다.

    STT·TTS 호출과 화자 식별은 `core/speech.py` 에 있다 — 다른 기능도 쓰는 단계라서다.
    여기 남은 것은 번역에만 있는 것들이다: 원문 확정(run_audio/run_text), 수신자별
    fan-out(_deliver), 그 과정의 metrics 와 progress 이벤트.
    """

    def __init__(self, speech: SpeechService, translator: Translator):
        self._speech = speech
        self._translator = translator

    # ---- 전체 흐름 ---------------------------------------------------------

    async def run_audio(
        self,
        session: Session,
        *,
        audio: bytes,
        filename: str,
        content_type: str,
        seg: int = 1,
        speaker_hint: str | None = None,
        stt_engine: str | None = None,
        tts_engine: str | None = None,
        voice: str | None = None,
        speed: float,
        response_format: str,
        provider: str | None = None,
        model: str | None = None,
        style: str | None = None,
        context: list[Turn] | None = None,
        glossary: dict[str, str] | None = None,
        with_audio: bool = True,
        progress: Progress | None = None,
        voices: SessionVoices | None = None,
    ) -> SegmentResult:
        loop = asyncio.get_running_loop()
        started = loop.time()
        metrics: dict[str, Any] = {}

        async def emit(stage: str, payload: dict) -> None:
            if progress is not None:
                await progress(stage, payload)

        # 1) 발화자 결정. 단방향이면 후보가 하나라 hint 없이도 정해진다.
        #
        # 오디오를 그대로 넘긴다 — voice_print 처럼 목소리를 들어야 하는 구현이 있고,
        # STT 가 받는 것과 같은 바이트를 써야 둘의 판단이 어긋나지 않는다.
        # 구현이 코루틴이면 await, 아니면 그대로 부른다 (identify() 가 흡수한다).
        decision = await self._speech.identify(
            session.speaker_id,
            [p.as_dict() for p in session.participants],
            mode=session.mode,
            hint=speaker_hint,
            audio=self._speech.utterance(audio, filename, content_type),
            text=None,
            voices=voices,
        )
        metrics.update(decision.detail)

        if decision.speaker is None:
            # 등록되지 않은 목소리(TV·행인)로 판정됐다. **오류가 아니다.**
            # 인식 텍스트가 비었을 때와 같은 방식으로 조용히 건너뛰고,
            # 왜 건너뛰었는지는 metrics 와 이 이벤트로 알 수 있게 남긴다.
            reason = decision.reason or "speaker not identified"
            metrics["skipped"] = reason
            metrics["total_ms"] = round((loop.time() - started) * 1000)
            skipped = SegmentResult(
                seg=seg, speaker="", source_lang="", source_text="", metrics=metrics
            )
            await emit("speaker.rejected", {"seg": seg, "reason": reason, **decision.detail})
            log.info("Segment %s skipped — %s", seg, reason)
            return skipped

        speaker_id = decision.speaker
        speaker = session.by_id(speaker_id)

        # 2) STT — 발화자의 언어로 인식한다
        stt = self._speech.pick(STT_KIND, session.mode, stt_engine)
        t0 = loop.time()
        heard = await self._speech.transcribe(stt, audio, filename, content_type, speaker.lang)
        metrics["stt_ms"] = round((loop.time() - t0) * 1000)
        metrics["audio_duration_s"] = heard.duration

        source_text = heard.text
        result = SegmentResult(
            seg=seg,
            speaker=speaker_id,
            source_lang=heard.language or speaker.lang,
            source_text=source_text,
            metrics=metrics,
            engines={"stt": stt.id},
        )
        await emit("stt.final", {
            "seg": seg,
            "from": speaker_id,
            "lang": result.source_lang,
            "text": source_text,
        })

        if not source_text:
            # 무음이거나 인식 실패. 오류가 아니라 빈 결과다.
            metrics["skipped"] = "no text recognized"
            metrics["total_ms"] = round((loop.time() - started) * 1000)
            return result

        # 3~4) 번역과 합성. 텍스트로 시작하는 경로와 공유한다.
        out = Outputs(
            speed=speed,
            response_format=response_format,
            tts_engine=tts_engine,
            voice=voice,
            provider=provider,
            model=model,
            style=style,
            context=context,
            glossary=glossary,
            with_audio=with_audio,
        )
        return await self._deliver(session, result, out, emit=emit, started=started)

    async def run_text(
        self,
        session: Session,
        *,
        text: str,
        seg: int = 1,
        speaker_hint: str | None = None,
        tts_engine: str | None = None,
        voice: str | None = None,
        speed: float,
        response_format: str,
        provider: str | None = None,
        model: str | None = None,
        style: str | None = None,
        context: list[Turn] | None = None,
        glossary: dict[str, str] | None = None,
        with_audio: bool = True,
        progress: Progress | None = None,
        voices: SessionVoices | None = None,
    ) -> SegmentResult:
        """
        이미 텍스트인 발화를 처리한다 — 기기에서 STT 를 돌린 클라이언트의 입구다.

        run_audio() 에서 STT 단계만 빠졌을 뿐, 화자 결정도 번역 방향 계산도
        같은 코드를 지난다. 원문 언어는 STT 가 알려주지 않으므로 발화자 참여자의
        언어를 그대로 쓴다 (세션이 정한 값이다).
        """
        loop = asyncio.get_running_loop()
        started = loop.time()
        metrics: dict[str, Any] = {}

        async def emit(stage: str, payload: dict) -> None:
            if progress is not None:
                await progress(stage, payload)

        # 1) 발화자 결정. 오디오가 없으므로 텍스트만 넘긴다 — 목소리를 들어야 하는
        # 구현(voice_print)은 "판정 못 함"으로 떨어지고 정책이 그것을 처리한다.
        # 여기서 구현별로 분기하지 않는 것이 요점이다.
        decision = await self._speech.identify(
            session.speaker_id,
            [p.as_dict() for p in session.participants],
            mode=session.mode,
            hint=speaker_hint,
            audio=None,
            text=text,
            voices=voices,
        )
        metrics.update(decision.detail)

        if decision.speaker is None:
            reason = decision.reason or "speaker not identified"
            metrics["skipped"] = reason
            metrics["total_ms"] = round((loop.time() - started) * 1000)
            await emit("speaker.rejected", {"seg": seg, "reason": reason, **decision.detail})
            log.info("Segment %s skipped — %s", seg, reason)
            return SegmentResult(
                seg=seg, speaker="", source_lang="", source_text="", metrics=metrics
            )

        speaker_id = decision.speaker
        speaker = session.by_id(speaker_id)
        source_text = text.strip()

        result = SegmentResult(
            seg=seg,
            speaker=speaker_id,
            source_lang=speaker.lang,
            source_text=source_text,
            metrics=metrics,
            engines={},
        )
        # STT 를 거치지 않았을 뿐 "원문이 확정됐다"는 같은 사건이다. 같은 stage 를 쓴다.
        await emit("stt.final", {
            "seg": seg,
            "from": speaker_id,
            "lang": result.source_lang,
            "text": source_text,
        })

        if not source_text:
            metrics["skipped"] = "no text recognized"
            metrics["total_ms"] = round((loop.time() - started) * 1000)
            return result

        out = Outputs(
            speed=speed,
            response_format=response_format,
            tts_engine=tts_engine,
            voice=voice,
            provider=provider,
            model=model,
            style=style,
            context=context,
            glossary=glossary,
            with_audio=with_audio,
        )
        return await self._deliver(session, result, out, emit=emit, started=started)

    async def _deliver(
        self,
        session: Session,
        result: SegmentResult,
        out: Outputs,
        *,
        emit: Progress,
        started: float,
    ) -> SegmentResult:
        """
        확정된 원문을 수신자별로 번역하고, 필요하면 수신자의 언어로 합성한다.

        **번역·합성이 일어나는 유일한 곳이다.** 오디오로 들어왔든 텍스트로 들어왔든
        여기서부터는 구분이 없다 — 입력 경로가 늘어도 방향 계산·from/to·metrics·
        progress 이벤트가 갈리지 않게 하기 위해서다.
        """
        loop = asyncio.get_running_loop()
        metrics = result.metrics
        seg = result.seg
        speaker_id = result.speaker

        # 번역 방향은 여기서 계산된다 — 발화자의 output 이 곧 수신자다
        listeners = session.listeners_of(speaker_id)
        tts: Engine | None = None
        if out.with_audio:
            tts = self._speech.pick(TTS_KIND, session.mode, out.tts_engine)
            result.engines["tts"] = tts.id

        for listener in listeners:
            t0 = loop.time()
            translated = await self._translator.translate(
                result.source_text,
                source_lang=result.source_lang,
                target_lang=listener.lang,
                provider=out.provider,
                model=out.model,
                style=out.style,
                context=out.context,
                glossary=out.glossary,
            )
            metrics[f"llm_ms.{listener.id}"] = round((loop.time() - t0) * 1000)

            delivery = Delivery(to=listener.id, lang=listener.lang, text=translated)
            await emit("llm.final", {
                "seg": seg,
                "from": speaker_id,
                "to": listener.id,
                "lang": listener.lang,
                "text": translated,
            })

            # TTS — 수신자의 언어로 합성
            if tts is not None and translated:
                t0 = loop.time()
                spoken = await self._speech.synthesize(
                    tts,
                    translated,
                    voice=out.voice,
                    language=listener.lang,
                    speed=out.speed,
                    response_format=out.response_format,
                )
                metrics[f"tts_ms.{listener.id}"] = round((loop.time() - t0) * 1000)
                delivery.audio = spoken.audio
                delivery.content_type = spoken.content_type
                delivery.sample_rate = spoken.sample_rate
                delivery.duration = spoken.duration

            result.deliveries.append(delivery)
            # 지금은 세그먼트 하나에 청크가 하나다(배치 TTS). 2단계에서 스트리밍 TTS 가
            # 붙으면 같은 stage 를 seq 를 올려가며 여러 번 부른다 — 계약은 그대로다.
            await emit("tts.final", {
                "seg": seg,
                "from": speaker_id,
                "to": listener.id,
                "seq": 0,
                "sr": delivery.sample_rate,
                "content_type": delivery.content_type,
                "duration": delivery.duration,
                "audio": delivery.audio,
            })

        metrics["total_ms"] = round((loop.time() - started) * 1000)
        return result
