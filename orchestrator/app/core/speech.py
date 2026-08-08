"""
음성 단계 — 오디오↔텍스트와 화자 식별.

여기 있는 것은 **흐름에 종속되지 않는 단계**뿐이다. "무엇 다음에 무엇"은 없다.
그 순서는 기능마다 다르고, 기능마다 다른 것은 모듈이 갖는다.

    번역          화자 식별 → 오디오→텍스트 → 번역 → 텍스트→오디오
    문서 음성화                              (번역) → 텍스트→오디오
    외국어 학습                텍스트→오디오 → 오디오→텍스트 → 평가 → 텍스트→오디오
    음성 대화                  오디오→텍스트 → 에이전트 → 텍스트→오디오

네 흐름이 전부 다르지만 **쓰는 단계는 같다.** 그래서 단계를 여기 두고 흐름을
모듈에 둔다. 새 기능을 붙일 때 STT/TTS 호출부를 다시 짜지 않게 하려는 것이다.

엔진 선택은 여전히 분기문이 아니다
----------------------------------
어느 엔진을 쓸지는 라우팅 정책이, 어떻게 부를지는 어댑터가 정한다. 이 클래스가
아는 것은 "종류가 stt/tts 인 엔진이 필요하다"는 것뿐이다 (`core/enginecall.py`).

두 층으로 쓴다
--------------
    pick() + transcribe()/synthesize()   어느 엔진이 골렸는지를 **먼저** 알아야 할 때.
                                         번역 모듈이 그렇다 — 응답의 engines 에 싣고,
                                         엔진이 없으면 번역을 시작하기 전에 멈춘다.
    to_text() / to_audio()               고르고 부르는 것을 한 번에. 대부분은 이걸로 족하다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Sequence

from . import enginecall
from .adapters.speaker_id._base import Decision, IdentifyContext, Utterance, identify
from .config import Config
from .engines import Engine, EngineRegistry

log = logging.getLogger("speech")

# 엔진 종류 이름. engines.yaml 의 `kind:` 이자 어댑터가 등록되는 레지스트리 종류다.
STT_KIND = "stt"
TTS_KIND = "tts"


@dataclass
class Transcript:
    """오디오에서 받아적은 것. `raw` 는 어댑터가 준 응답 그대로다."""

    text: str
    language: str | None
    duration: float | None
    engine: str
    raw: dict = field(default_factory=dict)


@dataclass
class Speech:
    """합성된 소리."""

    audio: bytes
    content_type: str | None
    sample_rate: int | None
    duration: float | None
    engine: str
    raw: dict = field(default_factory=dict)


class SpeechService:
    """
    STT·TTS 엔진 호출과 화자 식별을 한 곳에 모은 것.

    `voiceprints` / `speaker_engine` 은 화자 식별을 쓰지 않는 모듈(문서 음성화 등)이
    있으므로 없어도 된다. 그때 `identify()` 를 부르면 구현이 "판정 못 함"으로 떨어지고,
    정책이 그것을 처리한다 — 여기서 구현별로 분기하지 않는 것이 요점이다.
    """

    def __init__(
        self,
        cfg: Config,
        engines: EngineRegistry,
        voiceprints: Any = None,
        speaker_engine: Any = None,
    ):
        self._cfg = cfg
        self._engines = engines
        self._voiceprints = voiceprints
        self._speaker_engine = speaker_engine

    # ---- 엔진 선택 / 어댑터 생성 -------------------------------------------

    def pick(self, kind: str, mode: str, requested: str | None = None) -> Engine:
        return enginecall.pick(self._cfg, self._engines, kind=kind, mode=mode, requested=requested)

    def adapter(self, engine: Engine):
        return enginecall.adapter(self._cfg, engine)

    def target(self, engine: Engine) -> tuple[str, str]:
        return enginecall.target(self._engines, engine)

    # ---- 오디오 → 텍스트 ---------------------------------------------------

    async def transcribe(
        self,
        engine: Engine,
        audio: bytes,
        filename: str,
        content_type: str,
        language: str | None,
    ) -> Transcript:
        url, key = self.target(engine)
        body = await self.adapter(engine).transcribe(
            url=url,
            api_key=key,
            audio=audio,
            filename=filename,
            content_type=content_type,
            language=language,
        )
        return Transcript(
            text=body["text"],
            language=body.get("language"),
            duration=body.get("duration"),
            engine=engine.id,
            raw=body,
        )

    async def to_text(
        self,
        *,
        mode: str,
        audio: bytes,
        filename: str,
        content_type: str,
        language: str | None = None,
        engine: str | None = None,
    ) -> Transcript:
        """엔진을 골라 받아적는다. 고른 엔진 id 는 결과의 `engine` 에 있다."""
        return await self.transcribe(
            self.pick(STT_KIND, mode, engine), audio, filename, content_type, language
        )

    # ---- 텍스트 → 오디오 ---------------------------------------------------

    async def synthesize(
        self,
        engine: Engine,
        text: str,
        *,
        voice: str | None,
        language: str,
        speed: float,
        response_format: str,
    ) -> Speech:
        url, key = self.target(engine)
        body = await self.adapter(engine).synthesize(
            url=url,
            api_key=key,
            text=text,
            voice=voice,
            language=language,
            speed=speed,
            response_format=response_format,
        )
        return Speech(
            audio=body["audio"],
            content_type=body["content_type"],
            sample_rate=body["sample_rate"],
            duration=body["duration"],
            engine=engine.id,
            raw=body,
        )

    async def to_audio(
        self,
        *,
        mode: str,
        text: str,
        language: str,
        speed: float,
        response_format: str,
        voice: str | None = None,
        engine: str | None = None,
    ) -> Speech:
        """엔진을 골라 합성한다. 문서 음성화·학습·대화 모듈의 출구가 이것이다."""
        return await self.synthesize(
            self.pick(TTS_KIND, mode, engine),
            text,
            voice=voice,
            language=language,
            speed=speed,
            response_format=response_format,
        )

    # ---- 화자 식별 ---------------------------------------------------------

    async def identify(
        self,
        name: str,
        participants: Sequence[dict],
        *,
        mode: str,
        hint: str | None = None,
        audio: Utterance | None = None,
        text: str | None = None,
        voices: Any = None,
    ) -> Decision:
        """
        누가 말했는지. 구현(`manual`, `voice_print`, …)은 이름으로 찾는다.

        거부(`Decision.speaker is None`)는 오류가 아니다 — 등록되지 않은 목소리라는
        정상적인 판정이고, 호출자는 그 세그먼트를 건너뛰면 된다.
        자세한 계약은 `core/adapters/speaker_id/_base.py` 를 볼 것.
        """
        return await identify(
            name,
            participants,
            hint=hint,
            audio=audio,
            text=text,
            ctx=IdentifyContext(
                config=self._cfg,
                engine=self._speaker_engine,
                store=self._voiceprints,
                voices=voices,
                mode=mode,
            ),
        )

    @staticmethod
    def utterance(audio: bytes, filename: str, content_type: str) -> Utterance:
        """식별에 넘길 오디오. STT 에 넘기는 것과 **같은 바이트**를 쓴다."""
        return Utterance(data=audio, filename=filename, content_type=content_type)
