"""
정오 판정 저장소 — (사용자, 음성, STT 인식결과, 판정, 교정텍스트[틀렸을 때만]).

`verify` 요청이 오면 STT 를 돌린 결과를 **임시(pending) 상태로** 저장하고, 그
뒤에 오는 `verdict` 요청이 판정을 확정한다. 상태는 셋 중 하나다.

    pending    STT 는 돌렸지만 사용자가 아직 맞다/틀리다를 answer 하지 않았다
    correct    사용자가 인식 결과가 맞다고 확인했다 — (음성, 인식결과)가 그대로
               확인된 정답 쌍이 된다
    incorrect  사용자가 틀렸다고 표시했고, 정답 텍스트(corrected_text)도 함께 받았다
               — 정답 없이 "틀렸다"만 저장하는 것은 의미가 없으므로 거부한다(400,
               라우트에서 검사).

pending 상태로 오래 남는 것(사용자가 인식 결과를 보고도 판정 없이 이탈)은
"누구 것인지도 불분명한 음성이 무기한 쌓인다"는 위험이라 `verify_pending_ttl_hours`
가 지나면 지운다 — `voice_samples.py`/`read_store.py` 와 같은 자리(저장할 때마다
정리, 별도 크론 없음)에서 처리한다.

저장 방식은 이 계열의 공통 규칙(JSON 메타 + 스레드 락 + 원자적 쓰기)을 따르되,
오디오는 `verify_audio_dir` 에 따로 둔다.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ...core.config import Config
from ...core.errors import AppError

log = logging.getLogger("stt_training.verify")

STORE_VERSION = 1

_EXT_BY_CONTENT_TYPE = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
}

STATUS_PENDING = "pending"
STATUS_CORRECT = "correct"
STATUS_INCORRECT = "incorrect"


class VerifySampleError(AppError):
    default_code = "stt_training.verify_store_failed"
    default_status = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ext_for(content_type: str) -> str:
    return _EXT_BY_CONTENT_TYPE.get(content_type.lower().strip(), "") if content_type else ""


@dataclass
class VerifySample:
    id: str
    user_id: str
    created_at: str
    content_type: str
    size_bytes: int
    recognized_text: str
    status: str = STATUS_PENDING
    corrected_text: str | None = None
    confirmed_at: str | None = None
    stt_engine: str = ""

    def public(self) -> dict:
        """확정 이후 클라이언트에 내보내는 형태."""
        return {
            "id": self.id,
            "status": self.status,
            "recognized_text": self.recognized_text,
            "corrected_text": self.corrected_text,
            "created_at": self.created_at,
            "confirmed_at": self.confirmed_at,
        }

    def _filename(self) -> str:
        return f"{self.id}{_ext_for(self.content_type)}"


class VerifySampleStore:
    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._lock = threading.RLock()
        self._samples: dict[str, VerifySample] = {}
        self._path: Path | None = None
        self._audio_dir: Path | None = None
        self._error: str | None = None
        self._ensure()

    # ---- 로딩 -------------------------------------------------------------

    def _configured_path(self) -> Path:
        return Path(str(self._cfg.get("stt_training.verify_store_path")))

    def _configured_audio_dir(self) -> Path:
        return Path(str(self._cfg.get("stt_training.verify_audio_dir")))

    def _ensure(self) -> None:
        path = self._configured_path()
        audio_dir = self._configured_audio_dir()
        with self._lock:
            if path != self._path or audio_dir != self._audio_dir:
                self._path = path
                self._audio_dir = audio_dir
                self._load()

    def _load(self) -> None:
        path = self._path
        self._samples = {}
        self._error = None
        if path is None or not path.exists():
            log.info("Verify-sample store is empty (no file yet at %s)", path)
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for item in raw.get("samples") or []:
                vs = VerifySample(
                    id=str(item["id"]),
                    user_id=str(item["user_id"]),
                    created_at=str(item.get("created_at") or ""),
                    content_type=str(item.get("content_type") or ""),
                    size_bytes=int(item.get("size_bytes") or 0),
                    recognized_text=str(item.get("recognized_text") or ""),
                    status=str(item.get("status") or STATUS_PENDING),
                    corrected_text=item.get("corrected_text"),
                    confirmed_at=item.get("confirmed_at"),
                    stt_engine=str(item.get("stt_engine") or ""),
                )
                self._samples[vs.id] = vs
        except Exception as exc:
            self._samples = {}
            self._error = f"{type(exc).__name__}: {exc}"
            log.error("Could not read the stt_training verify store %s: %s", path, self._error)
            return
        log.info("Loaded %d verify sample(s) from %s", len(self._samples), path)

    def _save(self) -> None:
        path = self._path
        if path is None:
            raise VerifySampleError("stt_training.verify_store_not_configured")
        if self._error:
            raise VerifySampleError(
                "stt_training.verify_store_unreadable", path=path, reason=self._error
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {
            "version": STORE_VERSION,
            "note": (
                "STT-verify (right/wrong judgment) samples. Pending entries are audio + "
                "recognized text awaiting a verdict; confirmed entries additionally carry "
                "a correct/incorrect status and, when incorrect, the corrected text. Audio "
                "lives under the configured verify_audio_dir."
            ),
            "updated_at": _now(),
            "samples": [
                {
                    "id": vs.id,
                    "user_id": vs.user_id,
                    "created_at": vs.created_at,
                    "content_type": vs.content_type,
                    "size_bytes": vs.size_bytes,
                    "recognized_text": vs.recognized_text,
                    "status": vs.status,
                    "corrected_text": vs.corrected_text,
                    "confirmed_at": vs.confirmed_at,
                    "stt_engine": vs.stt_engine,
                }
                for vs in self._samples.values()
            ],
        }
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass

    def _audio_path(self, vs: VerifySample) -> Path:
        assert self._audio_dir is not None
        return self._audio_dir / vs.user_id / vs._filename()

    def _remove_locked(self, vs: VerifySample) -> None:
        self._samples.pop(vs.id, None)
        try:
            self._audio_path(vs).unlink(missing_ok=True)
        except OSError as exc:
            log.warning("Could not remove verify sample audio file for id=%s: %s", vs.id, exc)

    # ---- 조회 ---------------------------------------------------------------

    def get(self, sample_id: str) -> VerifySample | None:
        self._ensure()
        with self._lock:
            return self._samples.get(sample_id)

    def list(self, *, user_id: str) -> list[VerifySample]:
        self._ensure()
        with self._lock:
            items = [vs for vs in self._samples.values() if vs.user_id == user_id]
        items.sort(key=lambda vs: vs.created_at)
        return items

    def progress(self, *, user_id: str) -> int:
        """확정된(대기중이 아닌) 판정 개수."""
        return sum(1 for vs in self.list(user_id=user_id) if vs.status != STATUS_PENDING)

    def status(self) -> dict:
        self._ensure()
        with self._lock:
            return {
                "count": len(self._samples),
                "path": str(self._path),
                "audio_dir": str(self._audio_dir),
                "error": self._error,
            }

    # ---- 변경 -------------------------------------------------------------

    def create_pending(
        self,
        *,
        user_id: str,
        audio: bytes,
        content_type: str,
        recognized_text: str,
        stt_engine: str,
    ) -> VerifySample:
        if not user_id:
            raise VerifySampleError("stt_training.user_required", status=400)
        if not audio:
            raise VerifySampleError("audio.empty", status=400)

        self._ensure()
        with self._lock:
            self._expire_pending_locked()
            vs = VerifySample(
                id=uuid.uuid4().hex,
                user_id=user_id,
                created_at=_now(),
                content_type=content_type or "application/octet-stream",
                size_bytes=len(audio),
                recognized_text=recognized_text,
                status=STATUS_PENDING,
                stt_engine=stt_engine,
            )
            audio_path = self._audio_path(vs)
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = audio_path.with_name(audio_path.name + ".tmp")
            tmp.write_bytes(audio)
            os.replace(tmp, audio_path)
            try:
                audio_path.chmod(0o600)
            except OSError:
                pass

            self._samples[vs.id] = vs
            self._save()
        log.info(
            "Created pending verify sample for user (id=%s, %d bytes, engine=%s)",
            vs.id, vs.size_bytes, vs.stt_engine,
        )
        return vs

    def confirm(
        self, *, sample_id: str, user_id: str, correct: bool, corrected_text: str | None
    ) -> VerifySample:
        """
        판정을 확정한다. `correct=False` 인데 `corrected_text` 가 비어 있으면 400 —
        호출자(routes.py)가 이미 검사하지만, 저장소를 직접 쓰는 다른 경로가 생겨도
        이 불변식이 깨지지 않도록 여기서도 확인한다.
        """
        if not correct and not (corrected_text and corrected_text.strip()):
            raise VerifySampleError("stt_training.corrected_text_required", status=400)

        self._ensure()
        with self._lock:
            vs = self._samples.get(sample_id)
            if vs is None or vs.user_id != user_id:
                raise VerifySampleError("stt_training.sample_not_found", status=404,
                                         sample_id=sample_id)
            vs.status = STATUS_CORRECT if correct else STATUS_INCORRECT
            vs.corrected_text = corrected_text.strip() if corrected_text else None
            vs.confirmed_at = _now()
            self._samples[vs.id] = vs
            self._save()
        log.info("Confirmed verify sample (id=%s, status=%s)", vs.id, vs.status)
        return vs

    def _expire_pending_locked(self) -> None:
        """호출 시점에 이미 `self._lock` 을 쥐고 있어야 한다.

        판정 없이 `verify_pending_ttl_hours` 를 넘긴 pending 샘플을 지운다.
        0/None 이면(설정에서 끔) 아무것도 지우지 않는다.
        """
        ttl_hours = float(self._cfg.get("stt_training.verify_pending_ttl_hours"))
        if ttl_hours <= 0:
            return
        cutoff = datetime.now(timezone.utc) - timedelta(hours=ttl_hours)
        expired = []
        for vs in list(self._samples.values()):
            if vs.status != STATUS_PENDING:
                continue
            try:
                created = datetime.fromisoformat(vs.created_at)
            except ValueError:
                continue
            if created < cutoff:
                expired.append(vs)
        if not expired:
            return
        for vs in expired:
            self._remove_locked(vs)
        log.info("Expired %d pending verify sample(s) past the TTL", len(expired))
