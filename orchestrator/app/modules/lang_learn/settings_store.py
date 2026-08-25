"""
사용자별 언어 학습 설정 저장소.

DESIGN.md §15 / PLAN_LANG_LEARN.md — 스케줄·목표 언어·난이도·feedback_mode 는
**사용자마다 다른 값**이어야 한다. `core/moduleapi.py` 의 "모듈은 자기 이름의
최상위 섹션 하나를 갖는다"는 규약은 *정적* 설정(기본값, 어느 프로바이더를 쓸지
같은 운영 파라미터)을 위한 것이고, 사람 수만큼 늘어나는 데이터는 `core/users.py`·
`core/voice_samples.py` 와 같은 부류다 — 그래서 여기서는 그 둘과 같은 패턴(JSON
파일 + 스레드 락 + 원자적 쓰기)을 그대로 쓰되, **이 모듈 폴더 안에 둔다.**

core 에 두지 않은 이유: `core.users`/`core.voice_samples` 는 여러 모듈(화자 등록,
번역 세션 이력 등)이 참조할 수 있는 범용 개념이지만, 학습 스케줄·난이도·
feedback_mode 는 오직 `lang_learn` 모듈의 개념이다. 다른 모듈이 이걸 알 필요가
없으므로 core로 올려 전역 표면을 넓히는 대신 모듈 폴더 안에 둔다 — 나중에 다른
모듈이 정말 이 저장소를 참조해야 하는 상황이 오면 그때 core로 옮기는 것이 맞다
(옮기는 비용은 "필요해질 때까지 기다리는" 비용보다 항상 작다).

저장하는 값은 **부분 갱신**을 허용한다(`update()`). 사용자가 스케줄만 바꾸고
다른 필드는 손대지 않는 것이 흔한 사용 패턴이라, PUT 마다 전체 스키마를 다시
요구하면 클라이언트가 매번 GET 을 먼저 해야 한다. 저장 파일에는 사용자가
명시적으로 설정한 필드만 남고, 나머지는 조회 시점에 `lang_learn.defaults` 로
채워진다 — 그래야 서버 기본값이 바뀌면 아직 손대지 않은 사용자에게도 새 기본값이
바로 적용된다(설정 파일에 옛 기본값이 박혀 있지 않다).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ...core.config import Config
from ...core.errors import AppError

log = logging.getLogger("lang_learn.settings")

STORE_VERSION = 1

# 사용자가 PUT 으로 건드릴 수 있는 필드. DESIGN.md §15 의 스키마 그대로다.
PUBLIC_FIELDS = (
    "schedule",
    "target_lang",
    "level_mode",
    "manual_level",
    "feedback_mode",
    "show_text_for_repeat",
)

# 내부 전용 필드 — 응답에는 나가지 않는다. 적응형 난이도가 "지금 이 사용자가
# 몇 단계인지"를 세션 사이에 들고 있을 곳이 필요해서 같은 파일에 얹는다. 별도
# 저장소를 새로 만들지 않는 이유는 이 값이 사용자 설정과 생애주기가 같기
# 때문이다(사용자를 지우면 같이 지워져야 하는 종류의 데이터).
_INTERNAL_ADAPTIVE_LEVEL = "_adaptive_level"


class LangLearnSettingsError(AppError):
    default_code = "lang_learn.settings_failed"
    default_status = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class LangLearnSettingsStore:
    """사용자 id → 설정(부분) JSON 파일 하나. `core/users.py` 와 같은 로딩 규칙."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._lock = threading.RLock()
        self._rows: dict[str, dict[str, Any]] = {}
        self._path: Path | None = None
        self._error: str | None = None
        self._ensure()

    # ---- 로딩 -------------------------------------------------------------

    def _configured_path(self) -> Path:
        return Path(str(self._cfg.get("lang_learn.settings_store_path")))

    def _ensure(self) -> None:
        path = self._configured_path()
        with self._lock:
            if path != self._path:
                self._path = path
                self._load()

    def _load(self) -> None:
        path = self._path
        self._rows = {}
        self._error = None
        if path is None or not path.exists():
            log.info("Lang-learn settings store is empty (no file yet at %s)", path)
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            rows = raw.get("users") or {}
            if not isinstance(rows, dict):
                raise ValueError("'users' must be a mapping of user_id -> settings")
            self._rows = {str(uid): dict(row) for uid, row in rows.items()}
        except Exception as exc:
            self._rows = {}
            self._error = f"{type(exc).__name__}: {exc}"
            log.error("Could not read the lang_learn settings store %s: %s", path, self._error)
            return
        log.info("Loaded lang_learn settings for %d user(s) from %s", len(self._rows), path)

    def _save(self) -> None:
        path = self._path
        if path is None:
            raise LangLearnSettingsError("lang_learn.settings_store_not_configured")
        if self._error:
            raise LangLearnSettingsError(
                "lang_learn.settings_store_unreadable", path=path, reason=self._error
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {
            "version": STORE_VERSION,
            "note": "Per-user language-learning settings (schedule, level, feedback mode).",
            "updated_at": _now(),
            "users": self._rows,
        }
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass

    # ---- 검증 ---------------------------------------------------------------

    def _validate(self, patch: dict[str, Any]) -> dict[str, Any]:
        levels = list(self._cfg.get("lang_learn.levels"))
        out: dict[str, Any] = {}

        if "schedule" in patch:
            schedule = patch["schedule"]
            if not isinstance(schedule, list):
                raise LangLearnSettingsError("lang_learn.invalid_schedule", status=400)
            checked = []
            for item in schedule:
                if not isinstance(item, dict) or "time" not in item or "count" not in item:
                    raise LangLearnSettingsError("lang_learn.invalid_schedule", status=400)
                time_str = str(item["time"])
                try:
                    hh, mm = time_str.split(":")
                    if not (0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
                        raise ValueError
                except ValueError:
                    raise LangLearnSettingsError(
                        "lang_learn.invalid_schedule_time", status=400, time=time_str
                    ) from None
                count = int(item["count"])
                if count <= 0:
                    raise LangLearnSettingsError(
                        "lang_learn.invalid_schedule_count", status=400, count=count
                    )
                checked.append({"time": time_str, "count": count})
            out["schedule"] = checked

        if "target_lang" in patch:
            target_lang = str(patch["target_lang"]).strip()
            if not target_lang:
                raise LangLearnSettingsError("lang_learn.target_lang_required", status=400)
            out["target_lang"] = target_lang

        if "level_mode" in patch:
            level_mode = patch["level_mode"]
            if level_mode not in ("adaptive", "manual"):
                raise LangLearnSettingsError(
                    "lang_learn.invalid_level_mode", status=400, level_mode=level_mode
                )
            out["level_mode"] = level_mode

        if "manual_level" in patch:
            manual_level = patch["manual_level"]
            if manual_level is not None and manual_level not in levels:
                raise LangLearnSettingsError(
                    "lang_learn.invalid_level", status=400, level=manual_level,
                    available=", ".join(levels),
                )
            out["manual_level"] = manual_level

        if "feedback_mode" in patch:
            feedback_mode = patch["feedback_mode"]
            if feedback_mode not in ("immediate", "summary", "both"):
                raise LangLearnSettingsError(
                    "lang_learn.invalid_feedback_mode", status=400, feedback_mode=feedback_mode
                )
            out["feedback_mode"] = feedback_mode

        if "show_text_for_repeat" in patch:
            out["show_text_for_repeat"] = bool(patch["show_text_for_repeat"])

        unknown = set(patch) - set(PUBLIC_FIELDS)
        if unknown:
            raise LangLearnSettingsError(
                "lang_learn.unknown_settings_field", status=400,
                fields=", ".join(sorted(unknown)),
            )
        return out

    # ---- 조회/변경 ------------------------------------------------------------

    def get(self, user_id: str) -> dict[str, Any]:
        """저장된 값과 `lang_learn.defaults` 를 합친, 공개 스키마 그대로의 설정."""
        self._ensure()
        defaults = dict(self._cfg.get("lang_learn.defaults"))
        with self._lock:
            stored = self._rows.get(user_id) or {}
        merged = dict(defaults)
        for key in PUBLIC_FIELDS:
            if key in stored:
                merged[key] = stored[key]
        return merged

    def update(self, user_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        """부분 갱신. 준 필드만 덮어쓰고 나머지는 그대로 둔다. 갱신 후 전체 설정을 돌려준다."""
        if not user_id:
            raise LangLearnSettingsError("lang_learn.user_required", status=400)
        checked = self._validate(patch)
        self._ensure()
        with self._lock:
            row = dict(self._rows.get(user_id) or {})
            row.update(checked)
            self._rows[user_id] = row
            self._save()
        log.info("Updated lang_learn settings for a user (fields=%s)", sorted(checked))
        return self.get(user_id)

    # ---- 내부: 적응형 난이도 추적 ----------------------------------------------

    def get_adaptive_level(self, user_id: str) -> str | None:
        """마지막으로 정해진 적응형 단계. 아직 없으면 None(호출자가 기본 단계를 쓴다)."""
        self._ensure()
        with self._lock:
            row = self._rows.get(user_id) or {}
            return row.get(_INTERNAL_ADAPTIVE_LEVEL)

    def set_adaptive_level(self, user_id: str, level: str) -> None:
        self._ensure()
        with self._lock:
            row = dict(self._rows.get(user_id) or {})
            row[_INTERNAL_ADAPTIVE_LEVEL] = level
            self._rows[user_id] = row
            self._save()

    def status(self) -> dict:
        self._ensure()
        with self._lock:
            return {"count": len(self._rows), "path": str(self._path), "error": self._error}
