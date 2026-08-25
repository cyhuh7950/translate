"""
STT 개인화용 음성 샘플 저장소.

목적 — 사용자가 번역/학습 세션 등에서 말한 발화 중 일부를 사용자별로 축적해 두고,
나중에(이 모듈의 범위 밖) 그 사람 목소리에 맞춰 STT 를 재학습하는 데 쓴다.
**여기서는 저장까지만 한다.** 언제 어떤 흐름에서 실제로 `save()` 를 호출할지는
이 모듈이 정하지 않는다 — `modules/lang_learn` 등 상위 모듈이 결정한다.

★ 프라이버시 — 여기서 다루는 것은 `voiceprints.py` 의 화자 임베딩보다 **더 민감하다.**
  임베딩은 벡터라 원래 말이 무엇이었는지 알 수 없지만, 여기 저장되는 것은 원본
  오디오 그 자체다. 목소리(생체정보)뿐 아니라 **말한 내용까지** 들어 있다.
    - 오디오 파일은 평문으로, 메타데이터 저장소와는 다른 하위 경로(`audio_dir`)에
      둔다. 메타데이터만 봐서는 무슨 말인지 알 수 없다 — 우리가 메타데이터에
      텍스트(전사문)를 절대 넣지 않기 때문이다. 이 저장소는 애초에 전사문을
      받지 않는다(파라미터 자체가 없다).
    - 로그에는 사용자 id·샘플 id·바이트 수·길이 같은 메타데이터만 남긴다.
      오디오 내용, 파일 경로 안의 사람이 알아볼 만한 이름 등은 남기지 않는다.
    - 삭제는 사용자 단위로 전체 삭제만 지원한다(`delete_all`) — 이 저장소의
      목적상 "이 샘플 하나만 남기고" 같은 선택적 보존은 의미가 없고, 사용자가
      지우겠다고 하면 그 사람 몫을 통째로 지우는 것이 맞다.
    - 보관 정책(개수·기간·샘플 길이 상한)은 전부 설정에서 온다
      (`config/defaults.yaml` 의 `voice_samples:`) — 하드코딩하지 않는다.

저장 방식은 `voiceprints.py`/`users.py` 와 같다: JSON 메타 파일 + 스레드 락 +
원자적 쓰기. 오디오 바이트만 별도 디렉터리에 파일로 둔다(메타 파일 하나에 전부
욱여넣으면 파일이 계속 커지고, 텍스트 편집기로 열어볼 때마다 바이너리가 쏟아진다).
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

from .config import Config
from .errors import AppError

log = logging.getLogger("voice_samples")

# 저장 파일 포맷 버전. 형식이 바뀌면 올리고, 읽는 쪽이 판단할 근거로 쓴다.
STORE_VERSION = 1

# content_type -> 파일 확장자. 모르는 타입은 확장자 없이 그냥 id 로만 저장한다
# (내용을 열어보는 데는 메타데이터의 content_type 이 있으면 충분하다).
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


class VoiceSampleError(AppError):
    """음성 샘플 저장소를 읽거나 쓰지 못했다, 또는 저장 요청이 정책을 어겼다."""

    default_code = "voice_samples.failed"
    default_status = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ext_for(content_type: str) -> str:
    return _EXT_BY_CONTENT_TYPE.get(content_type.lower().strip(), "") if content_type else ""


# ---------------------------------------------------------------------------
# 샘플 하나 (메타데이터만 — 오디오 바이트는 따로 있다)
# ---------------------------------------------------------------------------


@dataclass
class VoiceSample:
    """
    음성 샘플 하나의 메타데이터. **전사문(텍스트)은 여기 없다** — 이 저장소가
    그 자체로 "내용까지 아는" 데이터가 되지 않도록 아예 받지 않는다.
    """

    id: str
    user_id: str
    created_at: str
    duration_s: float
    content_type: str
    size_bytes: int
    source: str = ""  # 어느 흐름에서 왔는지 힌트(예: "translation_session"). 선택.

    def public(self) -> dict:
        """클라이언트에 내보내는 형태. 오디오는 절대 포함하지 않는다(메타데이터뿐)."""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "created_at": self.created_at,
            "duration_s": self.duration_s,
            "content_type": self.content_type,
            "size_bytes": self.size_bytes,
            "source": self.source,
        }

    def _filename(self) -> str:
        return f"{self.id}{_ext_for(self.content_type)}"


# ---------------------------------------------------------------------------
# 저장소
# ---------------------------------------------------------------------------


class VoiceSampleStore:
    """
    사용자별 음성 샘플. 메타데이터는 JSON 파일 하나, 오디오는 `audio_dir` 아래
    사용자별 하위 폴더에 개별 파일로 둔다.

    경로는 설정(`voice_samples.store_path`, `voice_samples.audio_dir`)에서 온다.
    `config/` 는 읽기전용으로 마운트되므로 쓰기 가능한 볼륨(다른 저장소와 같은
    `../data`)을 쓴다.

    파일이 없으면 빈 저장소로 시작한다. 메타 파일이 깨져 있으면 **빈 상태로
    시작하되 쓰기를 막는다** — voiceprints.py/users.py 와 같은 이유(깨진 파일을
    조용히 덮어써서 남은 것까지 날리는 것이 가장 나쁘다).
    """

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._lock = threading.RLock()
        self._samples: dict[str, VoiceSample] = {}
        self._path: Path | None = None
        self._audio_dir: Path | None = None
        self._error: str | None = None
        self._ensure()

    # ---- 로딩 -------------------------------------------------------------

    def _configured_path(self) -> Path:
        return Path(str(self._cfg.get("voice_samples.store_path")))

    def _configured_audio_dir(self) -> Path:
        return Path(str(self._cfg.get("voice_samples.audio_dir")))

    def _ensure(self) -> None:
        """설정의 경로가 바뀌었으면 다시 읽는다. 설정 핫 리로드를 따라가기 위한 것이다."""
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
            log.info("Voice sample store is empty (no file yet at %s)", path)
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for item in raw.get("samples") or []:
                vs = VoiceSample(
                    id=str(item["id"]),
                    user_id=str(item["user_id"]),
                    created_at=str(item.get("created_at") or ""),
                    duration_s=float(item.get("duration_s") or 0.0),
                    content_type=str(item.get("content_type") or ""),
                    size_bytes=int(item.get("size_bytes") or 0),
                    source=str(item.get("source") or ""),
                )
                self._samples[vs.id] = vs
        except Exception as exc:
            self._samples = {}
            self._error = f"{type(exc).__name__}: {exc}"
            log.error("Could not read the voice sample store %s: %s", path, self._error)
            return
        log.info("Loaded %d voice sample(s) metadata from %s", len(self._samples), path)

    def _save(self) -> None:
        path = self._path
        if path is None:
            raise VoiceSampleError("voice_samples.store_not_configured")
        if self._error:
            raise VoiceSampleError("voice_samples.store_unreadable", path=path, reason=self._error)
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {
            "version": STORE_VERSION,
            "note": (
                "Voice sample metadata for STT personalization. The audio itself lives "
                "under the configured audio_dir, one file per sample. Both the metadata "
                "and the audio contain personal data (voice + speech content) — do not "
                "copy or share."
            ),
            "updated_at": _now(),
            "samples": [
                {
                    "id": vs.id,
                    "user_id": vs.user_id,
                    "created_at": vs.created_at,
                    "duration_s": vs.duration_s,
                    "content_type": vs.content_type,
                    "size_bytes": vs.size_bytes,
                    "source": vs.source,
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

    def _audio_path(self, vs: VoiceSample) -> Path:
        assert self._audio_dir is not None
        return self._audio_dir / vs.user_id / vs._filename()

    # ---- 조회 -------------------------------------------------------------

    def list(self, *, user_id: str) -> list[VoiceSample]:
        """이 사용자의 샘플 메타데이터. 오디오는 포함하지 않는다."""
        self._ensure()
        with self._lock:
            items = [vs for vs in self._samples.values() if vs.user_id == user_id]
        items.sort(key=lambda vs: vs.created_at)
        return items

    def count(self, *, user_id: str) -> int:
        return len(self.list(user_id=user_id))

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
        audio: bytes,
        content_type: str,
        duration_s: float,
        source: str = "",
    ) -> VoiceSample:
        """
        음성 샘플 하나를 저장한다. 사용자당 최대 개수/보관 기간, 샘플 하나의 최대
        길이는 전부 설정(`voice_samples.*`)이 정한다.

        오래된 샘플을 지우는 보존 정책은 여기서, 매 저장마다 적용한다 — 별도
        배치/크론이 없다. 사용자 수·저장 빈도가 낮은 이 서버 규모에서는 매 저장 시
        정리로도 충분하고, 그러면 "정리 잡이 안 돌면 무한히 쌓인다"는 실패 모드가
        생기지 않는다.
        """
        if not user_id:
            raise VoiceSampleError("voice_samples.user_required", status=400)
        if not audio:
            raise VoiceSampleError("voice_samples.empty_audio", status=400)

        max_duration = float(self._cfg.get("voice_samples.max_sample_duration_s"))
        if max_duration > 0 and duration_s > max_duration:
            raise VoiceSampleError(
                "voice_samples.too_long",
                status=400,
                duration_s=duration_s,
                maximum=max_duration,
            )

        self._ensure()
        with self._lock:
            vs = VoiceSample(
                id=uuid.uuid4().hex,
                user_id=user_id,
                created_at=_now(),
                duration_s=float(duration_s),
                content_type=content_type or "application/octet-stream",
                size_bytes=len(audio),
                source=source,
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
            self._enforce_retention_locked(user_id)
        # 오디오 내용·경로 안의 사람이 식별될 만한 정보는 로그에 남기지 않는다.
        log.info(
            "Saved voice sample for user (id=%s, %.1fs, %d bytes)",
            vs.id, vs.duration_s, vs.size_bytes,
        )
        return vs

    def _enforce_retention_locked(self, user_id: str) -> None:
        """호출 시점에 이미 `self._lock` 을 쥐고 있어야 한다.

        개수 상한과 보관 기간을 함께 적용한다. 둘 다 0/None 이면(설정에서 끔)
        아무것도 지우지 않는다.
        """
        max_count = int(self._cfg.get("voice_samples.max_per_user"))
        max_age_days = float(self._cfg.get("voice_samples.max_age_days"))

        mine = sorted(
            (vs for vs in self._samples.values() if vs.user_id == user_id),
            key=lambda vs: vs.created_at,
        )

        to_drop: list[VoiceSample] = []
        if max_age_days > 0:
            cutoff = datetime.now(timezone.utc).timestamp() - max_age_days * 86400
            for vs in mine:
                try:
                    created_ts = datetime.fromisoformat(vs.created_at).timestamp()
                except ValueError:
                    continue
                if created_ts < cutoff:
                    to_drop.append(vs)

        if max_count > 0 and len(mine) - len(to_drop) > max_count:
            remaining = [vs for vs in mine if vs not in to_drop]
            overflow = len(remaining) - max_count
            to_drop.extend(remaining[:overflow])

        if not to_drop:
            return
        for vs in to_drop:
            self._remove_locked(vs)
        self._save()
        log.info("Pruned %d old voice sample(s) for retention policy", len(to_drop))

    def _remove_locked(self, vs: VoiceSample) -> None:
        self._samples.pop(vs.id, None)
        try:
            self._audio_path(vs).unlink(missing_ok=True)
        except OSError as exc:
            log.warning("Could not remove voice sample audio file for id=%s: %s", vs.id, exc)

    def delete_all(self, *, user_id: str) -> int:
        """이 사용자의 샘플을 전부(메타데이터+오디오) 지운다. 지운 개수를 돌려준다."""
        self._ensure()
        with self._lock:
            mine = [vs for vs in self._samples.values() if vs.user_id == user_id]
            if not mine:
                return 0
            for vs in mine:
                self._remove_locked(vs)
            self._save()
        log.info("Deleted all %d voice sample(s) for a user", len(mine))
        return len(mine)
