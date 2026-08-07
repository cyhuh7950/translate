"""
구현체 레지스트리.

"구현체 선택이 분기문에 있으면 안 된다"는 원칙을 강제하는 곳이다.

    # 이렇게 쓰지 않는다 — 새 구현을 넣을 때마다 소스를 고쳐야 한다
    if backend == "silero":   return SileroVAD()
    elif backend == "webrtc": return WebRtcVAD()

    # 레지스트리에 등록하고 설정이 이름으로 고른다
    vad = registry.resolve("vad", cfg.get("vad.backend"))

새 구현을 추가하는 일은 **파일 하나 추가**로 끝난다. 기존 파일을 열 필요가 없다.

    # app/adapters/vad/webrtc.py
    from ..registry import register

    @register("vad", "webrtc")
    class WebRtcVad:
        ...

`discover()` 가 패키지 하위 모듈을 전부 import 하므로 등록 목록을 어디에도 나열하지 않는다.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from typing import Any, Callable, Iterable, TypeVar

log = logging.getLogger("registry")

T = TypeVar("T")

# (kind, name) → 구현체. 구현체는 클래스든 팩토리 함수든 상관없다.
_REGISTRY: dict[tuple[str, str], Any] = {}
_DISCOVERED: set[str] = set()


class RegistryError(Exception):
    pass


def register(kind: str, name: str) -> Callable[[T], T]:
    """구현체를 (종류, 이름)으로 등록한다. 데코레이터로 쓴다."""
    key = (kind, name)

    def decorator(obj: T) -> T:
        if key in _REGISTRY and _REGISTRY[key] is not obj:
            raise RegistryError(
                f"Implementation already registered: {kind}/{name} "
                f"({_REGISTRY[key]!r} vs {obj!r}). Use a different name"
            )
        _REGISTRY[key] = obj
        log.debug("Registered: %s/%s → %s", kind, name, getattr(obj, "__name__", obj))
        return obj

    return decorator


def resolve(kind: str, name: str) -> Any:
    """이름으로 구현체를 찾는다. 없으면 무엇이 있는지 알려주며 죽는다."""
    if not name:
        raise RegistryError(f"{kind} implementation name is empty. Check your config")
    try:
        return _REGISTRY[(kind, name)]
    except KeyError:
        raise RegistryError(
            f"Unregistered {kind} implementation: '{name}'. "
            f"Available: {', '.join(available(kind)) or '(none)'}"
        ) from None


def has(kind: str, name: str) -> bool:
    return (kind, name) in _REGISTRY


def available(kind: str) -> list[str]:
    """해당 종류로 등록된 이름들. /v1/config 응답과 가용성 판단에 쓴다."""
    return sorted(n for (k, n) in _REGISTRY if k == kind)


def kinds() -> list[str]:
    return sorted({k for (k, _) in _REGISTRY})


def snapshot() -> dict[str, list[str]]:
    return {k: available(k) for k in kinds()}


def discover(package: str) -> int:
    """
    패키지 하위 모듈을 전부 import 해서 자기등록시킨다.

    등록 목록을 코드 어디에도 나열하지 않기 위한 장치다. 파일을 넣으면 그걸로 끝이다.
    같은 패키지를 두 번 부르면 두 번째는 건너뛴다.
    """
    if package in _DISCOVERED:
        return 0

    try:
        pkg = importlib.import_module(package)
    except ModuleNotFoundError as exc:
        raise RegistryError(f"Package to discover not found: {package} ({exc})") from exc

    loaded = 0
    for mod in pkgutil.walk_packages(pkg.__path__, prefix=f"{package}."):
        if mod.name.rsplit(".", 1)[-1].startswith("_"):
            continue  # _base.py 처럼 밑줄로 시작하는 것은 내부용
        try:
            importlib.import_module(mod.name)
            loaded += 1
        except Exception as exc:  # 어댑터 하나가 깨져도 나머지는 살린다
            log.error("Failed to load adapter %s: %s", mod.name, exc)

    _DISCOVERED.add(package)
    log.info("%s discovery complete — %d modules, registered %s", package, loaded, snapshot())
    return loaded


def clear() -> None:
    """테스트용."""
    _REGISTRY.clear()
    _DISCOVERED.clear()
