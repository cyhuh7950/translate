"""
라우팅 정책 — 세션이 엔진을 명시하지 않았을 때 무엇을 고를지.

정책 이름은 defaults.yaml 의 `routing.policy` 로 지정한다.
새 정책은 이 폴더에 파일을 하나 더 넣고 @register 하면 된다. 여기를 고칠 필요가 없다.

정책 함수의 계약:
    policy(engines, *, kind, mode, requested) -> Engine
      engines   EngineRegistry
      kind      "stt" | "tts" ...
      mode      "batch" | "ptt" | "realtime" ...
      requested 세션이 지정한 엔진 id (없으면 None)
"""

from __future__ import annotations

from ...engines import Engine, EngineError, EngineRegistry
from ...errors import listing
from ...registry import register

ROUTING_KIND = "routing"


def _check(engine: Engine, mode: str) -> Engine:
    """지정된 엔진이 요청 모드를 지원하는지. 조용히 다른 모드로 격하시키지 않는다."""
    if not engine.supports(mode):
        raise EngineError(
            "engine.mode_unsupported",
            status=400,
            engine_id=engine.id,
            mode=mode,
            supported=listing(engine.modes),
        )
    if not engine.available:
        raise EngineError("engine.unreachable", engine_id=engine.id, reason=engine.last_error)
    if not engine.ready:
        raise EngineError("engine.not_ready", engine_id=engine.id, reason=engine.last_error)
    return engine


def _candidates(engines: EngineRegistry, kind: str, mode: str) -> list[Engine]:
    return engines.list(kind=kind, mode=mode, available_only=True)


def _no_candidate(kind: str, mode: str) -> EngineError:
    return EngineError("engine.none_available", kind=kind, mode=mode)


@register(ROUTING_KIND, "explicit")
def explicit(engines: EngineRegistry, *, kind: str, mode: str, requested: str | None) -> Engine:
    """세션이 지정한 것만 쓴다. 지정이 없으면 오류."""
    if not requested:
        raise EngineError("engine.explicit_required", status=400, kind=kind)
    return _check(engines.get(requested), mode)


@register(ROUTING_KIND, "mode_first")
def mode_first(engines: EngineRegistry, *, kind: str, mode: str, requested: str | None) -> Engine:
    """지정이 있으면 그것을, 없으면 모드를 지원하는 것 중 설정 순서대로."""
    if requested:
        return _check(engines.get(requested), mode)
    candidates = _candidates(engines, kind, mode)
    if not candidates:
        raise _no_candidate(kind, mode)
    return candidates[0]


@register(ROUTING_KIND, "nearest")
def nearest(engines: EngineRegistry, *, kind: str, mode: str, requested: str | None) -> Engine:
    """같은 서버의 엔진을 우선한다. 네트워크 왕복이 빠져 실시간에 유리하다."""
    if requested:
        return _check(engines.get(requested), mode)
    candidates = _candidates(engines, kind, mode)
    if not candidates:
        raise _no_candidate(kind, mode)
    here = engines.context().get("server_id")
    local = [e for e in candidates if e.server == here]
    return (local or candidates)[0]
