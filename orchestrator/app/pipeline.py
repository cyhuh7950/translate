"""
번역 파이프라인 — STT → (화자 식별) → LLM → TTS.

1단계는 배치/PTT 이지만 구조는 최종 목표(실시간 양방향)에 맞춰져 있다.

  - 세션은 참여자 목록을 갖고, 번역 방향은 **발화자 언어 → 수신자 언어**로 계산된다.
    코드에 "ko→en" 같은 상수가 없다.
  - 결과에는 항상 `from` / `to` 참여자 id 가 붙는다. 단방향에서도 마찬가지다.
    이 필드가 처음부터 있어야 양방향으로 갈 때 프로토콜을 깨지 않는다.
  - 처리 단위는 발화 전체가 아니라 **세그먼트**다. 지금은 세그먼트가 하나뿐이지만
    스트리밍으로 갈 때 이 경계가 그대로 쓰인다.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from . import registry
from .adapters.routing.policies import ROUTING_KIND
from .adapters.speaker_id.manual import SPEAKER_ID_KIND
from .config import Config
from .engines import Engine, EngineRegistry
from .llm import Translator, Turn
from .sessions import Session

log = logging.getLogger("pipeline")

STT_KIND = "stt"
TTS_KIND = "tts"

# 단계가 끝날 때마다 부르는 콜백. WS 스트림이 결과를 기다리지 않고 흘려보내는 통로다.
#   progress(stage, payload)  stage = "stt.final" | "llm.final" | "tts.final"
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
    def __init__(
        self,
        cfg: Config,
        engines: EngineRegistry,
        translator: Translator,
    ):
        self._cfg = cfg
        self._engines = engines
        self._translator = translator

    # ---- 엔진 선택 / 어댑터 생성 -------------------------------------------

    def _pick(self, kind: str, mode: str, requested: str | None) -> Engine:
        policy = registry.resolve(ROUTING_KIND, self._cfg.get("routing.policy"))
        return policy(self._engines, kind=kind, mode=mode, requested=requested)

    def _adapter(self, engine: Engine):
        cls = registry.resolve(engine.kind, engine.adapter)
        return cls(self._cfg.require_section("engine_http"))

    def _target(self, engine: Engine) -> tuple[str, str]:
        ep = self._engines.endpoint_for(engine)
        return ep.url, ep.api_key

    # ---- 단계 --------------------------------------------------------------

    async def _transcribe(
        self, engine: Engine, audio: bytes, filename: str, content_type: str, language: str | None
    ) -> dict:
        url, key = self._target(engine)
        return await self._adapter(engine).transcribe(
            url=url,
            api_key=key,
            audio=audio,
            filename=filename,
            content_type=content_type,
            language=language,
        )

    async def _synthesize(
        self, engine: Engine, text: str, *, voice: str | None, language: str, speed: float,
        response_format: str,
    ) -> dict:
        url, key = self._target(engine)
        return await self._adapter(engine).synthesize(
            url=url,
            api_key=key,
            text=text,
            voice=voice,
            language=language,
            speed=speed,
            response_format=response_format,
        )

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
    ) -> SegmentResult:
        loop = asyncio.get_running_loop()
        started = loop.time()
        metrics: dict[str, Any] = {}

        async def emit(stage: str, payload: dict) -> None:
            if progress is not None:
                await progress(stage, payload)

        # 1) 발화자 결정. 단방향이면 후보가 하나라 hint 없이도 정해진다.
        identify = registry.resolve(SPEAKER_ID_KIND, session.speaker_id)
        speaker_id = identify(
            [p.as_dict() for p in session.participants], hint=speaker_hint, audio=None, text=None
        )
        speaker = session.by_id(speaker_id)

        # 2) STT — 발화자의 언어로 인식한다
        stt = self._pick(STT_KIND, session.mode, stt_engine)
        t0 = loop.time()
        heard = await self._transcribe(stt, audio, filename, content_type, speaker.lang)
        metrics["stt_ms"] = round((loop.time() - t0) * 1000)
        metrics["audio_duration_s"] = heard.get("duration")

        source_text = heard["text"]
        result = SegmentResult(
            seg=seg,
            speaker=speaker_id,
            source_lang=heard.get("language") or speaker.lang,
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

        # 3) 수신자별로 번역 — 방향은 여기서 계산된다
        listeners = session.listeners_of(speaker_id)
        tts: Engine | None = None
        if with_audio:
            tts = self._pick(TTS_KIND, session.mode, tts_engine)
            result.engines["tts"] = tts.id

        for listener in listeners:
            t0 = loop.time()
            translated = await self._translator.translate(
                source_text,
                source_lang=result.source_lang,
                target_lang=listener.lang,
                provider=provider,
                model=model,
                style=style,
                context=context,
                glossary=glossary,
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

            # 4) TTS — 수신자의 언어로 합성
            if with_audio and tts is not None and translated:
                t0 = loop.time()
                spoken = await self._synthesize(
                    tts,
                    translated,
                    voice=voice,
                    language=listener.lang,
                    speed=speed,
                    response_format=response_format,
                )
                metrics[f"tts_ms.{listener.id}"] = round((loop.time() - t0) * 1000)
                delivery.audio = spoken["audio"]
                delivery.content_type = spoken["content_type"]
                delivery.sample_rate = spoken["sample_rate"]
                delivery.duration = spoken["duration"]

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
