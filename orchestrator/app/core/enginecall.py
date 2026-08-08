"""
엔진 호출 공통부 — 무엇을 고르고, 어떤 어댑터로, 어느 주소로 부르는가.

번역 파이프라인(STT/TTS)과 화자 임베딩이 같은 규칙을 써야 하므로 한 곳에 둔다.
여기서도 구현체 선택은 분기문이 아니라 레지스트리다.

    engine  = enginecall.pick(cfg, engines, kind="stt", mode="batch")
    url, key = enginecall.target(engines, engine)
    result  = await enginecall.adapter(cfg, engine).transcribe(url=url, api_key=key, ...)

`adapter()` 가 `engine.kind` 를 레지스트리 종류로 그대로 쓰기 때문에, 새 종류의
엔진(speaker 처럼)을 붙이는 일은 어댑터 파일 하나 추가 + engines.yaml 항목 추가로 끝난다.
"""

from __future__ import annotations

from . import registry
from .adapters.routing.policies import ROUTING_KIND
from .config import Config
from .engines import Engine, EngineRegistry


def pick(
    cfg: Config,
    engines: EngineRegistry,
    *,
    kind: str,
    mode: str,
    requested: str | None = None,
) -> Engine:
    """라우팅 정책이 고른다. 정책 이름은 설정(routing.policy)에서 온다."""
    policy = registry.resolve(ROUTING_KIND, cfg.get("routing.policy"))
    return policy(engines, kind=kind, mode=mode, requested=requested)


def adapter(cfg: Config, engine: Engine):
    """엔진의 API 방언에 맞는 어댑터 인스턴스. 방언 이름은 engines.yaml 의 adapter 다."""
    cls = registry.resolve(engine.kind, engine.adapter)
    return cls(cfg.require_section("engine_http"))


def target(engines: EngineRegistry, engine: Engine) -> tuple[str, str]:
    """조건에 맞는 엔드포인트의 (url, api_key). 키는 환경변수에서 온다."""
    ep = engines.endpoint_for(engine)
    return ep.url, ep.api_key
