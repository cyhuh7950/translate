"""
사용자별 언어 학습 이력 저장소.

세션 하나가 끝날 때마다 문제 목록·답변·개별 평가(점수+등급)·총평·그 세션이 쓴
feedback_mode 스냅샷을 저장한다. 내부 점수(0~100)는 여기에만 남는다 — 프로토콜
로는 등급만 나간다(DESIGN.md §15).

적응형 난이도(`level_mode: adaptive`)가 "최근 점수 추세"를 볼 곳이 이 저장소다
(`recent_scores()`). 저장 방식은 다른 저장소와 같다: JSON 파일 + 스레드 락 +
원자적 쓰기. 사용자당 보관 개수는 `lang_learn.history_max_per_user` 로 제한한다
(voice_samples.py 의 보존 정책과 같은 이유 — 무한히 쌓이지 않게).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ...core.config import Config
from ...core.errors import AppError

log = logging.getLogger("lang_learn.history")

STORE_VERSION = 1


class LangLearnHistoryError(AppError):
    default_code = "lang_learn.history_failed"
    default_status = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class ProblemRecord:
    idx: int
    answer_type: str
    problem_text: str
    answer_text: str
    score: int
    grade: str
    comment: str


@dataclass
class SessionRecord:
    id: str
    user_id: str
    created_at: str
    target_lang: str
    level: str
    feedback_mode: str
    problems: list[ProblemRecord] = field(default_factory=list)
    summary_score: int | None = None
    summary_grade: str | None = None
    summary_comment: str | None = None

    def average_score(self) -> float | None:
        """이 세션의 평균 내부 점수. 문제가 하나도 없으면 None(적응형 계산에서 건너뛴다)."""
        if not self.problems:
            return None
        return sum(p.score for p in self.problems) / len(self.problems)

    def public(self) -> dict:
        """클라이언트에 내보내는 형태 — 내부 점수는 여기서도 뺀다(등급만)."""
        return {
            "id": self.id,
            "created_at": self.created_at,
            "target_lang": self.target_lang,
            "level": self.level,
            "feedback_mode": self.feedback_mode,
            "problems": [
                {
                    "idx": p.idx,
                    "answer_type": p.answer_type,
                    "problem_text": p.problem_text,
                    "answer_text": p.answer_text,
                    "grade": p.grade,
                    "comment": p.comment,
                }
                for p in self.problems
            ],
            "summary_grade": self.summary_grade,
            "summary_comment": self.summary_comment,
        }

    def _asdict(self) -> dict:
        """내부 저장 형태 — 점수도 함께 남는다(적응형 난이도가 읽어야 한다)."""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "created_at": self.created_at,
            "target_lang": self.target_lang,
            "level": self.level,
            "feedback_mode": self.feedback_mode,
            "problems": [
                {
                    "idx": p.idx,
                    "answer_type": p.answer_type,
                    "problem_text": p.problem_text,
                    "answer_text": p.answer_text,
                    "score": p.score,
                    "grade": p.grade,
                    "comment": p.comment,
                }
                for p in self.problems
            ],
            "summary_score": self.summary_score,
            "summary_grade": self.summary_grade,
            "summary_comment": self.summary_comment,
        }


class LangLearnHistoryStore:
    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._lock = threading.RLock()
        self._sessions: dict[str, SessionRecord] = {}
        self._path: Path | None = None
        self._error: str | None = None
        self._ensure()

    # ---- 로딩 -------------------------------------------------------------

    def _configured_path(self) -> Path:
        return Path(str(self._cfg.get("lang_learn.history_store_path")))

    def _ensure(self) -> None:
        path = self._configured_path()
        with self._lock:
            if path != self._path:
                self._path = path
                self._load()

    def _load(self) -> None:
        path = self._path
        self._sessions = {}
        self._error = None
        if path is None or not path.exists():
            log.info("Lang-learn history store is empty (no file yet at %s)", path)
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for item in raw.get("sessions") or []:
                problems = [
                    ProblemRecord(
                        idx=int(p["idx"]),
                        answer_type=str(p["answer_type"]),
                        problem_text=str(p.get("problem_text") or ""),
                        answer_text=str(p.get("answer_text") or ""),
                        score=int(p.get("score") or 0),
                        grade=str(p.get("grade") or ""),
                        comment=str(p.get("comment") or ""),
                    )
                    for p in (item.get("problems") or [])
                ]
                rec = SessionRecord(
                    id=str(item["id"]),
                    user_id=str(item["user_id"]),
                    created_at=str(item.get("created_at") or ""),
                    target_lang=str(item.get("target_lang") or ""),
                    level=str(item.get("level") or ""),
                    feedback_mode=str(item.get("feedback_mode") or ""),
                    problems=problems,
                    summary_score=(
                        int(item["summary_score"]) if item.get("summary_score") is not None else None
                    ),
                    summary_grade=item.get("summary_grade"),
                    summary_comment=item.get("summary_comment"),
                )
                self._sessions[rec.id] = rec
        except Exception as exc:
            self._sessions = {}
            self._error = f"{type(exc).__name__}: {exc}"
            log.error("Could not read the lang_learn history store %s: %s", path, self._error)
            return
        log.info("Loaded %d lang_learn session record(s) from %s", len(self._sessions), path)

    def _save(self) -> None:
        path = self._path
        if path is None:
            raise LangLearnHistoryError("lang_learn.history_store_not_configured")
        if self._error:
            raise LangLearnHistoryError(
                "lang_learn.history_store_unreadable", path=path, reason=self._error
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {
            "version": STORE_VERSION,
            "note": "Language-learning session history (problems, answers, scores, summaries).",
            "updated_at": _now(),
            "sessions": [rec._asdict() for rec in self._sessions.values()],
        }
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass

    # ---- 조회 -------------------------------------------------------------

    def list(self, *, user_id: str) -> list[SessionRecord]:
        self._ensure()
        with self._lock:
            items = [s for s in self._sessions.values() if s.user_id == user_id]
        items.sort(key=lambda s: s.created_at)
        return items

    def recent_scores(self, *, user_id: str, limit: int) -> list[float]:
        """최근 `limit` 세션의 평균 점수(오래된 것 → 최신 순은 아니고, 최신이 마지막)."""
        items = self.list(user_id=user_id)
        scores = [s.average_score() for s in items if s.average_score() is not None]
        return scores[-limit:] if limit > 0 else scores

    def status(self) -> dict:
        self._ensure()
        with self._lock:
            return {"count": len(self._sessions), "path": str(self._path), "error": self._error}

    # ---- 변경 -------------------------------------------------------------

    def save(self, record: SessionRecord) -> SessionRecord:
        self._ensure()
        with self._lock:
            self._sessions[record.id] = record
            self._save()
            self._enforce_retention_locked(record.user_id)
        log.info(
            "Saved lang_learn session for a user (id=%s, %d problem(s))",
            record.id, len(record.problems),
        )
        return record

    def _enforce_retention_locked(self, user_id: str) -> None:
        max_per_user = int(self._cfg.get("lang_learn.history_max_per_user"))
        if max_per_user <= 0:
            return
        mine = sorted(
            (s for s in self._sessions.values() if s.user_id == user_id),
            key=lambda s: s.created_at,
        )
        overflow = len(mine) - max_per_user
        if overflow <= 0:
            return
        for rec in mine[:overflow]:
            self._sessions.pop(rec.id, None)
        self._save()
        log.info("Pruned %d old lang_learn session record(s) for retention policy", overflow)

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex
