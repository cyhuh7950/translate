"""
낭독 교정 저장소 — (사용자, 문장 텍스트, 음성) 확정쌍.

★ `core/voice_samples.py` 와 의도적으로 다르다. 그 저장소는 사생활 보호를 위해
전사문을 아예 받지 않는다(자유발화라 무슨 말을 했는지 남기지 않는 것이 목적).
여기는 반대다 — 사용자가 화면에 이미 뜬, 서버가 미리 정한 문장을 그대로 읽은
것이라 "무슨 말을 했는지"가 애초에 비밀이 아니고, 오히려 그 텍스트가 있어야
(음성, 정답) 쌍으로서 재학습 재료가 된다. 그래서 텍스트를 메타데이터에 같이
저장한다.

저장 방식은 이 저장소 계열의 공통 규칙(JSON 메타 + 스레드 락 + 원자적 쓰기,
`lang_learn/history_store.py`·`core/voice_samples.py` 와 같다)을 따르되, 오디오
바이트는 메타 파일과 분리해 `read_audio_dir` 아래 사용자별 폴더에 둔다(이유도
`voice_samples.py` 와 같다 — 메타 파일을 열어볼 때마다 바이너리가 쏟아지지
않게, 그리고 삭제를 단순하게 하기 위해서).

**진행도는 문장(prompt) id 기준으로 센다** — 같은 문장을 두 번 읽어도 진행도가
두 번 늘지 않는다. 그래야 "아직 안 읽은 문장 하나"를 고르는 `next_prompt` 로직과
"몇 개 남았는지"를 세는 `status` 가 같은 개념을 쓴다.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ...core.config import Config
from ...core.errors import AppError

log = logging.getLogger("stt_training.read")

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


class ReadSampleError(AppError):
    default_code = "stt_training.read_store_failed"
    default_status = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ext_for(content_type: str) -> str:
    return _EXT_BY_CONTENT_TYPE.get(content_type.lower().strip(), "") if content_type else ""


@dataclass
class ReadSample:
    """낭독 교정 샘플 하나. `text` 는 사용자가 읽으라고 받은 문장 그대로다."""

    id: str
    user_id: str
    prompt_id: str
    lang: str
    text: str
    created_at: str
    content_type: str
    size_bytes: int

    def public(self) -> dict:
        return {
            "id": self.id,
            "prompt_id": self.prompt_id,
            "lang": self.lang,
            "text": self.text,
            "created_at": self.created_at,
        }

    def _filename(self) -> str:
        return f"{self.id}{_ext_for(self.content_type)}"


class ReadSampleStore:
    """사용자별 낭독 샘플. `voice_samples.py` 와 같은 파일 배치 규칙을 쓴다."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._lock = threading.RLock()
        self._samples: dict[str, ReadSample] = {}
        self._path: Path | None = None
        self._audio_dir: Path | None = None
        self._error: str | None = None
        self._ensure()

    # ---- 로딩 -------------------------------------------------------------

    def _configured_path(self) -> Path:
        return Path(str(self._cfg.get("stt_training.read_store_path")))

    def _configured_audio_dir(self) -> Path:
        return Path(str(self._cfg.get("stt_training.read_audio_dir")))

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
            log.info("Read-sample store is empty (no file yet at %s)", path)
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for item in raw.get("samples") or []:
                rs = ReadSample(
                    id=str(item["id"]),
                    user_id=str(item["user_id"]),
                    prompt_id=str(item["prompt_id"]),
                    lang=str(item.get("lang") or ""),
                    text=str(item.get("text") or ""),
                    created_at=str(item.get("created_at") or ""),
                    content_type=str(item.get("content_type") or ""),
                    size_bytes=int(item.get("size_bytes") or 0),
                )
                self._samples[rs.id] = rs
        except Exception as exc:
            self._samples = {}
            self._error = f"{type(exc).__name__}: {exc}"
            log.error("Could not read the stt_training read store %s: %s", path, self._error)
            return
        log.info("Loaded %d read sample(s) from %s", len(self._samples), path)

    def _save(self) -> None:
        path = self._path
        if path is None:
            raise ReadSampleError("stt_training.read_store_not_configured")
        if self._error:
            raise ReadSampleError(
                "stt_training.read_store_unreadable", path=path, reason=self._error
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {
            "version": STORE_VERSION,
            "note": (
                "Read-aloud STT-training samples: (user, prompt text, audio) pairs. The "
                "audio itself lives under the configured read_audio_dir, one file per "
                "sample."
            ),
            "updated_at": _now(),
            "samples": [
                {
                    "id": rs.id,
                    "user_id": rs.user_id,
                    "prompt_id": rs.prompt_id,
                    "lang": rs.lang,
                    "text": rs.text,
                    "created_at": rs.created_at,
                    "content_type": rs.content_type,
                    "size_bytes": rs.size_bytes,
                }
                for rs in self._samples.values()
            ],
        }
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass

    def _audio_path(self, rs: ReadSample) -> Path:
        assert self._audio_dir is not None
        return self._audio_dir / rs.user_id / rs._filename()

    # ---- 조회 ---------------------------------------------------------------

    def list(self, *, user_id: str) -> list[ReadSample]:
        self._ensure()
        with self._lock:
            items = [rs for rs in self._samples.values() if rs.user_id == user_id]
        items.sort(key=lambda rs: rs.created_at)
        return items

    def done_prompt_ids(self, *, user_id: str) -> set[str]:
        """이 사용자가 이미 읽어서 저장한 문장(prompt) id 집합. 언어를 가리지 않는다."""
        return {rs.prompt_id for rs in self.list(user_id=user_id)}

    def progress(self, *, user_id: str) -> int:
        """서로 다른 문장을 몇 개 읽었는지. 같은 문장을 여러 번 읽어도 한 번으로 센다."""
        return len(self.done_prompt_ids(user_id=user_id))

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

    def save(
        self,
        *,
        user_id: str,
        prompt_id: str,
        lang: str,
        text: str,
        audio: bytes,
        content_type: str,
    ) -> ReadSample:
        if not user_id:
            raise ReadSampleError("stt_training.user_required", status=400)
        if not audio:
            raise ReadSampleError("audio.empty", status=400)

        self._ensure()
        with self._lock:
            rs = ReadSample(
                id=uuid.uuid4().hex,
                user_id=user_id,
                prompt_id=prompt_id,
                lang=lang,
                text=text,
                created_at=_now(),
                content_type=content_type or "application/octet-stream",
                size_bytes=len(audio),
            )
            audio_path = self._audio_path(rs)
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = audio_path.with_name(audio_path.name + ".tmp")
            tmp.write_bytes(audio)
            os.replace(tmp, audio_path)
            try:
                audio_path.chmod(0o600)
            except OSError:
                pass

            self._samples[rs.id] = rs
            self._save()
        log.info(
            "Saved read-aloud sample for user (id=%s, prompt_id=%s, %d bytes)",
            rs.id, rs.prompt_id, rs.size_bytes,
        )
        return rs
