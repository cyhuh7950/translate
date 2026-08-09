"""
오류 문구 카탈로그 — 코드(code)를 사람이 읽는 문장으로 바꾼다.

이 프로젝트의 규칙은 "아무것도 소스에 고정하지 않는다"이고, 문구도 예외가 아니다.
코드는 **코드와 파라미터만** 만든다.

    raise EngineError("engine.unreachable", engine_id="whisper", reason="timeout")

문장은 `config/messages/<locale>.yaml` 에서 온다. `en.yaml` 이 완전한 원본이고,
다른 로케일은 번역본이라 빠진 키는 en 으로 떨어진다. 로케일 정규화와 폴백 규칙은
`i18n.py` 것을 그대로 쓴다 — 표시 언어 규칙이 두 벌이 되면 어긋난다.

**여기서는 예외를 던지지 않는다.** 이 모듈이 불리는 시점은 이미 오류를 처리하는
중이다. 문구가 없거나 파라미터가 빠져 있으면 진단용 문자열을 돌려주고 경고 로그를
남긴다. 오류를 알리려다 다시 죽는 것이 가장 나쁘다.

카탈로그 디렉터리
-----------------
설정 디렉터리 아래의 하위 디렉터리 하나다 (`config/messages/`). 설정 로더는 최상위
`*.yaml` 만 병합하므로 이 파일들이 설정값에 섞이지 않는다.

디렉터리 이름이 코드에 있는 것은 **부트스트랩**이기 때문이다. 설정을 읽다 실패한
오류(`config.dir_missing` 등)도 문구가 있어야 하므로, 카탈로그는 설정보다 먼저
읽혀야 한다. 설정 디렉터리 경로 자체가 환경변수로만 오는 것과 같은 이유다.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Mapping

import yaml

from .i18n import FALLBACK_LOCALE, normalize

log = logging.getLogger("messages")

# 설정 디렉터리 아래에서 카탈로그를 찾을 하위 디렉터리. 부트스트랩이다 (위 주석 참고).
SUBDIR = "messages"

# 카탈로그에 코드가 없거나 파라미터가 모자랄 때 돌려줄 문구. 사용자에게 보여줄
# 문장이 아니라 "이 코드의 문구가 없다"는 사실을 알리는 진단이다. 카탈로그를 읽지
# 못한 상황에서도 나와야 하므로 카탈로그에 두지 않는다.
DIAGNOSTIC = "[missing message template: {code}] {params}"

_lock = threading.RLock()
_catalog: dict[str, dict[str, str]] = {}


def load(config_dir: str | Path) -> int:
    """
    `<config_dir>/messages/*.yaml` 을 전부 읽어 갈아끼운다. 파일 이름이 로케일이다.

    실패해도 예외를 던지지 않는다 — 문구를 못 읽었다고 서버가 뜨지 못하면 안 된다.
    대신 오류 로그를 남기고 읽은 것만 반영한다.
    """
    directory = Path(config_dir) / SUBDIR
    table: dict[str, dict[str, str]] = {}

    if not directory.is_dir():
        log.error("Message catalog directory not found: %s", directory)
    else:
        for path in sorted(directory.glob("*.yaml")):
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            except (OSError, yaml.YAMLError) as exc:
                log.error("Could not read the message catalog %s: %s", path.name, exc)
                continue
            if not isinstance(data, dict):
                log.error("The top level of the message catalog %s must be a mapping", path.name)
                continue
            locale = normalize(path.stem)
            entries = table.setdefault(locale, {})
            for code, template in data.items():
                if template is None:
                    continue
                entries[str(code)] = str(template)

    with _lock:
        _catalog.clear()
        _catalog.update(table)

    total = sum(len(v) for v in table.values())
    log.info(
        "Message catalogs loaded from %s: %s",
        directory,
        ", ".join(f"{loc}={len(entries)}" for loc, entries in sorted(table.items())) or "(none)",
    )
    if FALLBACK_LOCALE not in table:
        log.error(
            "The message catalog has no '%s' locale — every message will fall back to a "
            "diagnostic string. Expected %s/%s.yaml",
            FALLBACK_LOCALE,
            directory,
            FALLBACK_LOCALE,
        )
    return total


def locales() -> list[str]:
    """카탈로그가 있는 로케일들."""
    with _lock:
        return sorted(_catalog)


def codes(locale: str | None = None) -> set[str]:
    """카탈로그에 있는 코드. 로케일을 주지 않으면 기본어의 것."""
    with _lock:
        return set(_catalog.get(normalize(locale), {}))


def has(code: str, locale: str | None = None) -> bool:
    """이 코드의 문구가 있는가 (폴백 포함)."""
    return _template(code, locale) is not None


def _template(code: str, locale: str | None) -> str | None:
    """요청 로케일 → 기본어 순으로 찾는다. 없으면 None."""
    want = normalize(locale)
    with _lock:
        found = _catalog.get(want, {}).get(code)
        if found is not None:
            return found
        return _catalog.get(FALLBACK_LOCALE, {}).get(code)


def render(code: str, params: Mapping[str, Any] | None = None, locale: str | None = None) -> str:
    """
    코드와 파라미터를 문장으로. **어떤 경우에도 예외를 던지지 않는다.**

    문구가 없거나 치환 이름이 맞지 않으면 진단 문자열을 돌려주고 경고를 남긴다.
    그러면 화면에는 코드와 파라미터가 그대로 보이므로 무엇이 빠졌는지 드러난다.
    """
    values = dict(params or {})
    template = _template(code, locale)
    if template is None:
        log.warning("No message template for '%s' (locale=%s)", code, normalize(locale))
        return DIAGNOSTIC.format(code=code, params=values)
    try:
        return template.format(**values)
    except Exception as exc:
        # 파라미터가 빠졌거나(KeyError) 치환 문법이 틀렸다. 여기서 죽으면 안 된다.
        log.warning(
            "Message '%s' could not be formatted (%s: %s)", code, type(exc).__name__, exc
        )
        return DIAGNOSTIC.format(code=code, params=values)
