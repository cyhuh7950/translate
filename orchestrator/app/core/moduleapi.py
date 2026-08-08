"""
모듈 계약 — 기능 하나를 폴더 하나로 붙이고 떼는 방법.

이 오케스트레이터는 앞으로 네 가지를 한다. 흐름이 전부 다르다.

    ① 음성 번역        화자 식별 → STT → 번역 → TTS      (지금 있는 것)
    ② 문서 음성 변환   문서 파싱 → (번역) → TTS          STT 없음, 대화 없음
    ③ 외국어 학습      스케줄 → TTS → STT → 평가 → TTS   상태 있음
    ④ 음성 대화        STT → 에이전트 → TTS              턴이 이어짐

흐름이 다른 것들을 한 파일에 넣으면 분기문이 자란다. 그래서 **흐름은 모듈이 갖고,
단계는 core 가 갖는다.** 모듈은 `app/modules/` 아래 폴더 하나이고, 그 폴더를 통째로
다른 프로젝트에 옮겨 붙일 수 있어야 한다 — 그러려면 모듈이 core 만 알아야 하고,
다른 모듈이나 server.py 를 알아서는 안 된다.

붙이는 법
---------
폴더를 만들고 `__init__.py` 에서 등록하면 끝이다. **어디에도 목록을 적지 않는다** —
`discover()` 가 패키지를 훑는다. 어댑터와 같은 방식이다(`core/registry.py`).

    # app/modules/tutor/__init__.py
    from ...core.moduleapi import Module, module

    @module("tutor")
    class TutorModule(Module):
        def routes(self):
            from .routes import build
            return build(self.ctx)          # 자기 APIRouter

        def config_view(self, locale):
            c = self.ctx.config
            return {"tutor": {"levels": c.get("tutor.levels")}}

        async def startup(self):  ...       # 선택
        async def shutdown(self): ...       # 선택

모듈이 제공하는 것
------------------
    routes()        자기 APIRouter. 공용 인증은 `ctx.auth` 를 라우트에 걸어 쓴다.
    config_view()   `/v1/config` 응답에 실을 자기 섹션(들). 그래야 모듈의 클라이언트
                    UI 도 서버 응답만 보고 그려진다 — 화면에 상수를 두지 않기 위해서다.
    startup/shutdown  기동·종료 시 할 일 (선택).

설정 규약
---------
**모듈은 자기 이름의 최상위 섹션 하나를 갖는다.** 다른 모듈의 섹션을 읽지 않는다.

    # config/defaults.yaml
    tutor:
      levels: [beginner, intermediate]

core 가 쓰는 섹션(`server`, `auth`, `session`, `audio`, `engines`, `speaker_id` …)은
모듈도 읽어도 된다. 공용 기반이기 때문이다. 쓰기는 어느 쪽도 하지 않는다.

`config_view()` 가 낸 키가 core 섹션이나 다른 모듈의 키와 겹치면 기동 시점에 죽는다.
조용히 덮어써서 클라이언트가 엉뚱한 값을 보는 것보다 낫다.

왜 어댑터 레지스트리에 얹지 않는가
----------------------------------
어댑터는 **한 자리를 두고 갈아끼우는 구현체**이고(`vad` 자리에 energy 냐 silero 냐),
모듈은 **서로 대체하지 않는 기능**이다. 둘을 한 표에 담으면 `/v1/config` 의
`implementations`("지금 무엇이 꽂혀 있나")가 두 가지 다른 뜻을 갖게 된다.
그래서 표는 따로 두되, 등록 방식은 그대로 데코레이터 + 패키지 훑기다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, TypeVar

from . import registry
from .config import Config
from .engines import EngineRegistry
from .llm import ProviderRegistry, Translator
from .sessions import ProfileRegistry
from .speech import SpeechService
from .voiceprints import SpeakerEngine, VoicePrintStore

log = logging.getLogger("modules")

T = TypeVar("T")

# 이름 → 모듈 클래스. 어댑터와 같은 방식이지만 표는 따로다 (위 주석을 볼 것).
_MODULES: dict[str, Any] = {}


class ModuleError(Exception):
    pass


@dataclass
class ModuleContext:
    """
    모듈이 받는 공용 서비스 묶음.

    모듈은 이것만 안다. server.py 도, 다른 모듈도 알지 못한다 —
    폴더째 옮겨 붙일 수 있으려면 의존이 core 한쪽으로만 흘러야 하기 때문이다.

        config          설정 (읽기 전용)
        engines         원격 엔진 레지스트리와 관측된 가용성
        profiles        세션 프로필 / 참여자 모델
        providers       LLM 프로바이더 레지스트리
        translator      LLM 번역기 (프롬프트 구성 포함)
        speech          오디오↔텍스트·화자 식별
        voiceprints     명시적으로 등록된 목소리 (파일)
        speaker_engine  화자 임베딩 엔진 호출부
        auth            공용 인증 의존성. 라우트에 `dependencies=[ctx.auth]` 로 건다
        ws_authorized   WebSocket 인증. 핸드셰이크 단계에서 부른다
        reload_if_changed  설정 핫 리로드. 요청 처리 앞에서 부른다
    """

    config: Config
    engines: EngineRegistry
    profiles: ProfileRegistry
    providers: ProviderRegistry
    translator: Translator
    speech: SpeechService
    voiceprints: VoicePrintStore
    speaker_engine: SpeakerEngine
    auth: Any = None
    ws_authorized: Callable[[Any], bool] = lambda ws: True
    reload_if_changed: Callable[[], bool] = lambda: False
    # 모듈이 필요로 하는 것이 늘면 여기에 얹는다. 모듈 쪽 서명은 바뀌지 않는다.
    extra: dict = field(default_factory=dict)


class Module:
    """
    모듈의 기본형. 전부 선택이므로 필요한 것만 덮어쓰면 된다.

    `name` 은 등록할 때 채워진다 — 클래스에 이름을 두 번 적지 않기 위해서다.
    """

    name: str = ""

    def __init__(self, ctx: ModuleContext):
        self.ctx = ctx

    def routes(self):
        """자기 `APIRouter`. 없으면 None."""
        return None

    def config_view(self, locale: str | None) -> dict | None:
        """`/v1/config` 에 실을 자기 섹션(들). 없으면 None."""
        return None

    async def startup(self) -> None:
        """기동 시 할 일."""

    async def shutdown(self) -> None:
        """종료 시 할 일. startup 이 실패해도 불린다."""


def module(name: str) -> Callable[[T], T]:
    """모듈을 이름으로 등록한다. 데코레이터로 쓴다."""
    def decorator(cls: T) -> T:
        if name in _MODULES and _MODULES[name] is not cls:
            raise ModuleError(
                f"Module already registered: {name} ({_MODULES[name]!r} vs {cls!r}). "
                f"Use a different name"
            )
        cls.name = name                     # type: ignore[attr-defined]
        _MODULES[name] = cls
        log.debug("Registered module: %s → %s", name, getattr(cls, "__name__", cls))
        return cls
    return decorator


def available() -> list[str]:
    return sorted(_MODULES)


def discover(package: str) -> int:
    """
    패키지 하위를 전부 import 해서 자기등록시킨다.

    어댑터와 같은 장치를 쓴다 — 목록을 코드 어디에도 나열하지 않기 위해서다.
    폴더를 넣으면 그것으로 끝이고, 빼면 그것으로 끝난다.
    """
    loaded = registry.discover(package)
    log.info("Modules registered: %s", ", ".join(available()) or "(none)")
    return loaded


def build(ctx: ModuleContext) -> list[Module]:
    """등록된 모듈을 전부 만든다. 순서는 이름순이라 기동마다 같다."""
    return [_MODULES[name](ctx) for name in available()]


def config_sections(
    modules: list[Module], locale: str | None, reserved: dict[str, str] | None = None
) -> dict:
    """
    모듈들의 `/v1/config` 기여를 합친다.

    키가 겹치면 죽는다 — core 섹션과 겹쳐도, 모듈끼리 겹쳐도 마찬가지다.
    조용히 덮어써서 클라이언트가 엉뚱한 값을 보는 것보다 낫다.
    `reserved` 는 core 가 이미 쓰고 있는 키다 (키 → 임자).
    """
    out: dict = {}
    owner: dict[str, str] = dict(reserved or {})
    for mod in modules:
        section = mod.config_view(locale) or {}
        for key, value in section.items():
            if key in owner:
                raise ModuleError(
                    f"Modules '{owner[key]}' and '{mod.name}' both contribute the "
                    f"'{key}' section to /v1/config. Rename one of them"
                )
            owner[key] = mod.name
            out[key] = value
    return out


def clear() -> None:
    """테스트용."""
    _MODULES.clear()
