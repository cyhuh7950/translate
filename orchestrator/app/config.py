"""
설정 로더.

이 프로젝트의 규칙은 "아무것도 소스에 고정하지 않는다"이고, 그 규칙을 강제하는 곳이 여기다.

  - `get()` 에는 기본값 인자가 없다. 설정에 없으면 ConfigError 로 죽는다.
    `os.getenv("PORT", "8401")` 같은 코드 폴백을 쓸 수 없게 만드는 것이 목적이다.
  - 값이 없어도 되는 경우에는 `get_optional()` 로 명시한다. 이때도 기본값은 못 준다.

병합 우선순위 (뒤가 이긴다):
    defaults.yaml  →  기타 *.yaml  →  *.local.yaml  →  환경변수  →  관리 API

문자열 안의 `${VAR}` 는 환경변수로 치환된다. 비밀값을 설정 파일에 적지 않기 위한 장치다.
"""

from __future__ import annotations

import copy
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger("config")

# 환경변수로 설정을 덮어쓸 때 쓰는 접두사와 중첩 구분자.
#   TRANSLATE__server__port=9000  →  server.port = 9000
ENV_PREFIX = "TRANSLATE__"
ENV_NESTING = "__"

_VAR_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

_MISSING = object()


class ConfigError(Exception):
    """설정이 없거나 잘못됐다. 코드가 임의로 기본값을 지어내지 않고 여기서 멈춘다."""


def _deep_merge(base: dict, over: dict) -> dict:
    """over 가 base 를 덮는다. dict 는 재귀 병합, 그 외(리스트 포함)는 통째로 교체."""
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def _expand_vars(node: Any) -> Any:
    """문자열 안의 ${VAR} 를 환경변수로 치환한다. 없는 변수는 빈 문자열."""
    if isinstance(node, str):
        return _VAR_PATTERN.sub(lambda m: os.environ.get(m.group(1), ""), node)
    if isinstance(node, dict):
        return {k: _expand_vars(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_expand_vars(v) for v in node]
    return node


def _coerce(text: str) -> Any:
    """환경변수는 전부 문자열로 오므로 YAML 스칼라로 해석해 타입을 살린다."""
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError:
        return text


def _env_overrides() -> dict:
    """TRANSLATE__a__b=1 형태의 환경변수를 중첩 dict 로 바꾼다."""
    out: dict = {}
    for key, raw in os.environ.items():
        if not key.startswith(ENV_PREFIX):
            continue
        parts = [p for p in key[len(ENV_PREFIX):].split(ENV_NESTING) if p]
        if not parts:
            continue
        cursor = out
        for p in parts[:-1]:
            cursor = cursor.setdefault(p.lower(), {})
            if not isinstance(cursor, dict):  # a__b 와 a__b__c 가 충돌하는 경우
                raise ConfigError(f"환경변수 설정 경로가 충돌합니다: {key}")
        cursor[parts[-1].lower()] = _coerce(raw)
    return out


def _load_dir(path: Path) -> tuple[dict, dict[Path, float]]:
    """설정 디렉터리의 yaml 을 정해진 순서로 병합한다. (병합결과, 파일별 mtime)"""
    if not path.is_dir():
        raise ConfigError(f"설정 디렉터리가 없습니다: {path}")

    files = sorted(p for p in path.glob("*.yaml") if p.is_file())
    # defaults 를 맨 앞, *.local.yaml 을 맨 뒤로. 나머지는 이름순.
    def order(p: Path) -> tuple[int, str]:
        if p.name == "defaults.yaml":
            return (0, p.name)
        if p.name.endswith(".local.yaml"):
            return (2, p.name)
        return (1, p.name)

    merged: dict = {}
    stamps: dict[Path, float] = {}
    for f in sorted(files, key=order):
        try:
            data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            raise ConfigError(f"{f.name} 파싱 실패: {exc}") from exc
        if not isinstance(data, dict):
            raise ConfigError(f"{f.name} 최상위는 매핑이어야 합니다")
        merged = _deep_merge(merged, data)
        stamps[f] = f.stat().st_mtime

    if not merged:
        raise ConfigError(f"설정 디렉터리에 읽을 내용이 없습니다: {path}")
    return merged, stamps


class Config:
    """읽기 전용 설정 뷰. 파일이 바뀌면 reload 로 갈아끼운다."""

    def __init__(self, config_dir: str | Path):
        self._dir = Path(config_dir)
        self._lock = threading.RLock()
        self._runtime: dict = {}      # 관리 API 로 넣은 최상위 오버라이드
        self._data: dict = {}
        self._stamps: dict[Path, float] = {}
        self.reload()

    # ---- 로딩 -------------------------------------------------------------

    def reload(self) -> None:
        with self._lock:
            files, stamps = _load_dir(self._dir)
            data = _deep_merge(files, _env_overrides())
            data = _deep_merge(data, self._runtime)
            self._data = _expand_vars(data)
            self._stamps = stamps
            log.info("설정 로드 완료 (%d개 파일, %s)", len(stamps), self._dir)

    def maybe_reload(self) -> bool:
        """파일이 추가·수정·삭제됐으면 다시 읽는다. 재기동 없이 설정이 반영되도록."""
        with self._lock:
            current = {p: p.stat().st_mtime for p in self._dir.glob("*.yaml") if p.is_file()}
            if current == self._stamps:
                return False
        log.info("설정 파일 변경 감지 — 다시 읽습니다")
        self.reload()
        return True

    def set_runtime(self, patch: dict) -> None:
        """관리 API 용. 가장 높은 우선순위로 얹힌다. 재기동 없이 바뀐다."""
        with self._lock:
            self._runtime = _deep_merge(self._runtime, patch)
        self.reload()

    def clear_runtime(self) -> None:
        with self._lock:
            self._runtime = {}
        self.reload()

    # ---- 조회 -------------------------------------------------------------

    def _lookup(self, path: str) -> Any:
        cursor: Any = self._data
        for part in path.split("."):
            if not isinstance(cursor, dict) or part not in cursor:
                return _MISSING
            cursor = cursor[part]
        return cursor

    def get(self, path: str) -> Any:
        """설정값. 없으면 죽는다 — 기본값 인자를 일부러 두지 않았다."""
        value = self._lookup(path)
        if value is _MISSING:
            raise ConfigError(
                f"설정값이 없습니다: '{path}'. "
                f"{self._dir}/defaults.yaml 에 추가하거나 "
                f"{ENV_PREFIX}{path.replace('.', ENV_NESTING)} 로 주입하세요"
            )
        return copy.deepcopy(value) if isinstance(value, (dict, list)) else value

    def get_optional(self, path: str) -> Any | None:
        """정말로 없어도 되는 값. 기본값은 여기서도 못 준다 — 설정에 두어야 한다."""
        value = self._lookup(path)
        if value is _MISSING:
            return None
        return copy.deepcopy(value) if isinstance(value, (dict, list)) else value

    def require_section(self, path: str) -> dict:
        value = self.get(path)
        if not isinstance(value, dict):
            raise ConfigError(f"'{path}' 는 매핑이어야 합니다 (현재: {type(value).__name__})")
        return value

    def as_dict(self) -> dict:
        with self._lock:
            return copy.deepcopy(self._data)

    @property
    def config_dir(self) -> Path:
        return self._dir
