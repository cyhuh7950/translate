"""
화자 등록 저장소 (voice print) 와 화자 임베딩 엔진 호출부.

★ 프라이버시 — 여기서 다루는 임베딩은 **생체정보에 준하는 개인정보다.**
  목소리에서 뽑아낸 192차원 벡터로, 이것만으로 음성을 복원할 수는 없지만
  같은 사람을 다시 알아보는 데는 충분하다. 즉 다른 곳에서 녹음된 음성과 대조해
  신원을 특정할 수 있다. 지문과 같은 성질의 데이터로 취급해야 한다.
    - 저장 파일은 평문 JSON 이다. 접근 권한이 있는 사람은 그대로 읽을 수 있다.
    - 로그·API 응답·진단 덤프 어디에도 벡터 자체를 내보내지 않는다.
    - 사용자가 지우겠다고 하면 즉시 지워져야 한다 (DELETE /v1/speakers/{id}).

두 저장소를 나눈 이유
--------------------
    명시적 등록 (VoicePrintStore)  사용자가 직접 올려 등록한 것 → **파일로 남는다**
    자동 등록   (SessionVoices)    대화 중 저절로 배운 것       → **메모리에만** 남는다

자동 등록은 "등록 화면 없이 대화만 시작하면 되게" 하려는 편의 기능이고, 그때 사용자는
자기 목소리가 저장된다는 인식이 없다. 그런 데이터를 디스크에 남기지 않기 위해
세션이 끝나면 함께 사라지는 메모리에만 둔다.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from . import enginecall
from .config import Config
from .engines import EngineRegistry
from .errors import AppError

log = logging.getLogger("voiceprints")

# 엔진 종류 이름. engines.yaml 의 `kind:` 와 어댑터의 등록 종류가 이 값이다.
SPEAKER_KIND = "speaker"

# 저장 파일 포맷 버전. 형식이 바뀌면 올리고, 읽는 쪽이 판단할 근거로 쓴다.
STORE_VERSION = 1


class VoicePrintError(AppError):
    """등록된 목소리 저장소를 읽거나 쓰지 못했다."""

    default_code = "voiceprint.failed"
    default_status = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def unit(vec: np.ndarray) -> np.ndarray:
    """L2 정규화. 정규화된 벡터끼리는 내적이 곧 코사인 유사도다."""
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 0 else vec


# ---------------------------------------------------------------------------
# 등록 항목
# ---------------------------------------------------------------------------


@dataclass
class VoicePrint:
    """
    등록된 화자 하나.

    id 는 **세션 참여자 id** 다 (프로필의 `a`, `b`, `speaker` 등). 그래야 대조 결과가
    곧바로 참여자로 이어지고, 중간에 "이 사람은 어느 참여자인가" 하는 표를 하나 더
    두지 않아도 된다. 프로필이 다르면 참여자 id 도 다르므로 그에 맞춰 등록해야 한다.

    embedding 은 등록 발화들의 평균 벡터다 — ★ 생체정보에 준한다. 외부로 내보내지 않는다.
    """

    id: str
    name: str
    embedding: list[float]
    utterances: int
    created_at: str
    updated_at: str
    dim: int = 0
    engine: str = ""
    model: str = ""

    def public(self) -> dict:
        """클라이언트에 내보내는 형태. **임베딩은 절대 넣지 않는다.**"""
        return {
            "id": self.id,
            "name": self.name,
            "utterances": self.utterances,
            "dim": self.dim,
            "engine": self.engine,
            "model": self.model,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    def vector(self) -> np.ndarray:
        return unit(np.asarray(self.embedding, dtype=np.float32))


# ---------------------------------------------------------------------------
# 파일 저장소 — 명시적 등록
# ---------------------------------------------------------------------------


class VoicePrintStore:
    """
    명시적으로 등록된 화자들을 JSON 파일 하나에 담는다.

    경로는 설정(`speaker_id.store_path`)에서 온다. `config/` 는 읽기전용으로 마운트되므로
    쓰기 가능한 볼륨(compose 의 `../data` → `/data`)을 따로 둔다.

    파일이 없으면 빈 저장소로 시작한다 — 등록한 적이 없는 상태가 정상이기 때문이다.
    파일이 깨져 있으면 **빈 상태로 시작하되 쓰기를 막는다.** 깨진 파일을 조용히
    덮어써서 남은 등록까지 날리는 것이 가장 나쁜 결과이기 때문이다.
    """

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._lock = threading.RLock()
        self._prints: dict[str, VoicePrint] = {}
        self._path: Path | None = None
        self._error: str | None = None
        self._ensure()

    # ---- 로딩 -------------------------------------------------------------

    def _configured_path(self) -> Path:
        return Path(str(self._cfg.get("speaker_id.store_path")))

    def _ensure(self) -> None:
        """설정의 경로가 바뀌었으면 다시 읽는다. 설정 핫 리로드를 따라가기 위한 것이다."""
        path = self._configured_path()
        with self._lock:
            if path != self._path:
                self._path = path
                self._load()

    def _load(self) -> None:
        path = self._path
        self._prints = {}
        self._error = None
        if path is None or not path.exists():
            log.info("Voice print store is empty (no file yet at %s)", path)
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for item in raw.get("speakers") or []:
                vp = VoicePrint(
                    id=str(item["id"]),
                    name=str(item.get("name") or item["id"]),
                    embedding=[float(x) for x in item["embedding"]],
                    utterances=int(item.get("utterances") or 0),
                    created_at=str(item.get("created_at") or ""),
                    updated_at=str(item.get("updated_at") or ""),
                    dim=int(item.get("dim") or len(item["embedding"])),
                    engine=str(item.get("engine") or ""),
                    model=str(item.get("model") or ""),
                )
                self._prints[vp.id] = vp
        except Exception as exc:
            # 여기서 죽지 않는다. 대신 쓰기를 막아 남은 파일을 지키고, 이유를 남긴다.
            self._prints = {}
            self._error = f"{type(exc).__name__}: {exc}"
            log.error("Could not read the voice print store %s: %s", path, self._error)
            return
        log.info("Loaded %d voice print(s) from %s", len(self._prints), path)

    def _save(self) -> None:
        path = self._path
        if path is None:
            raise VoicePrintError("voiceprint.store_not_configured")
        if self._error:
            raise VoicePrintError("voiceprint.store_unreadable", path=path, reason=self._error)
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {
            "version": STORE_VERSION,
            # 파일을 직접 열어본 사람에게도 이것이 무엇인지 알려둔다.
            "note": (
                "Speaker embeddings. Treat these as biometric personal data: they identify "
                "a person's voice. Do not copy or share this file."
            ),
            "updated_at": _now(),
            "speakers": [
                {
                    "id": vp.id,
                    "name": vp.name,
                    "embedding": vp.embedding,
                    "utterances": vp.utterances,
                    "dim": vp.dim,
                    "engine": vp.engine,
                    "model": vp.model,
                    "created_at": vp.created_at,
                    "updated_at": vp.updated_at,
                }
                for vp in self._prints.values()
            ],
        }
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # 원자적 교체. 쓰는 도중 죽어도 이전 파일이 온전히 남는다.
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass  # 파일시스템이 권한을 지원하지 않을 수 있다. 저장 자체는 성공했다.

    # ---- 조회 -------------------------------------------------------------

    def list(self) -> list[VoicePrint]:
        self._ensure()
        with self._lock:
            return list(self._prints.values())

    def get(self, speaker_id: str) -> VoicePrint | None:
        self._ensure()
        with self._lock:
            return self._prints.get(speaker_id)

    def count(self) -> int:
        self._ensure()
        with self._lock:
            return len(self._prints)

    def ids(self) -> list[str]:
        return [vp.id for vp in self.list()]

    def status(self) -> dict:
        """/v1/config 와 목록 API 에 얹는 상태. 벡터는 들어가지 않는다."""
        self._ensure()
        with self._lock:
            return {
                "count": len(self._prints),
                "path": str(self._path),
                "error": self._error,
            }

    # ---- 변경 -------------------------------------------------------------

    def put(
        self,
        *,
        speaker_id: str,
        name: str,
        embedding: Sequence[float],
        utterances: int,
        dim: int = 0,
        engine: str = "",
        model: str = "",
    ) -> VoicePrint:
        """등록하거나 갱신한다. 같은 id 가 있으면 통째로 대체한다."""
        if not speaker_id:
            raise VoicePrintError("voiceprint.speaker_required", status=400)
        vec = [float(x) for x in embedding]
        if not vec:
            raise VoicePrintError("voiceprint.empty_embedding", status=502)

        self._ensure()
        with self._lock:
            existing = self._prints.get(speaker_id)
            vp = VoicePrint(
                id=speaker_id,
                name=name or speaker_id,
                embedding=vec,
                utterances=int(utterances),
                created_at=existing.created_at if existing else _now(),
                updated_at=_now(),
                dim=int(dim or len(vec)),
                engine=engine,
                model=model,
            )
            self._prints[speaker_id] = vp
            self._save()
        log.info("Enrolled voice print '%s' (%d utterance(s))", speaker_id, utterances)
        return vp

    def delete(self, speaker_id: str) -> bool:
        self._ensure()
        with self._lock:
            if speaker_id not in self._prints:
                return False
            del self._prints[speaker_id]
            self._save()
        log.info("Deleted voice print '%s'", speaker_id)
        return True


# ---------------------------------------------------------------------------
# 메모리 저장소 — 자동 등록
# ---------------------------------------------------------------------------


class SessionVoices:
    """
    세션 중에 저절로 배운 목소리. **메모리에만 있고 세션이 끝나면 사라진다.**

    첫 발화를 첫 참여자에게 배정하고, 그와 충분히 다른(임계값 미만) 목소리가 나오면
    다음 참여자에게 배정하는 식으로 늘어난다. 배정 판단은 이 클래스가 하지 않는다 —
    여기는 "배운 것"만 들고 있고, 누구에게 줄지는 정책이 정한다.

    `limit` 발화까지는 들어올 때마다 평균을 갱신한다. 표본이 늘수록 임베딩이
    안정되기 때문이다. 그 이후로는 갱신하지 않는다 — 잘못 배정된 발화가 계속
    섞여 들어와 목소리가 서서히 다른 사람 쪽으로 끌려가는 것을 막기 위해서다.
    """

    def __init__(self, limit: int):
        self._limit = max(1, int(limit))
        self._voices: dict[str, np.ndarray] = {}
        self._counts: dict[str, int] = {}

    def learn(self, speaker_id: str, vec: np.ndarray) -> int:
        current = self._voices.get(speaker_id)
        if current is None:
            self._voices[speaker_id] = unit(np.asarray(vec, dtype=np.float32))
            self._counts[speaker_id] = 1
            return 1

        count = self._counts[speaker_id]
        if count >= self._limit:
            return count            # 이미 충분히 모았다. 더 흔들지 않는다.
        merged = (current * count + unit(np.asarray(vec, dtype=np.float32))) / (count + 1)
        self._voices[speaker_id] = unit(merged)
        self._counts[speaker_id] = count + 1
        return count + 1

    def items(self) -> Iterable[tuple[str, np.ndarray]]:
        return self._voices.items()

    def ids(self) -> list[str]:
        return list(self._voices)

    def count_of(self, speaker_id: str) -> int:
        return self._counts.get(speaker_id, 0)

    def complete(self, speaker_id: str) -> bool:
        """이 목소리를 확정된 것으로 볼 수 있는가(설정한 발화 수를 채웠는가)."""
        return self.count_of(speaker_id) >= self._limit

    def __len__(self) -> int:
        return len(self._voices)


# ---------------------------------------------------------------------------
# 엔진 호출
# ---------------------------------------------------------------------------


class SpeakerEngine:
    """
    화자 임베딩 엔진을 부르는 얇은 층.

    어느 엔진을 쓸지는 라우팅 정책이 고르고, 어떻게 부를지는 어댑터가 안다.
    이 클래스가 아는 것은 "종류가 speaker 인 엔진이 필요하다"는 것뿐이다.
    """

    def __init__(self, cfg: Config, engines: EngineRegistry):
        self._cfg = cfg
        self._engines = engines

    def _resolve(self, mode: str):
        engine = enginecall.pick(self._cfg, self._engines, kind=SPEAKER_KIND, mode=mode)
        url, key = enginecall.target(self._engines, engine)
        return engine, enginecall.adapter(self._cfg, engine), url, key

    async def embed(
        self, *, mode: str, data: bytes, filename: str, content_type: str
    ) -> dict[str, Any]:
        """발화 하나의 임베딩. 결과에 `vector`(np.ndarray)와 엔진 id 를 얹어 돌려준다."""
        engine, adapter, url, key = self._resolve(mode)
        body = await adapter.embed(
            url=url, api_key=key, audio=data, filename=filename, content_type=content_type
        )
        body["vector"] = unit(np.asarray(body.get("embedding") or [], dtype=np.float32))
        body["engine"] = engine.id
        return body

    async def enroll(self, *, mode: str, files: Sequence[tuple[str, bytes, str]]) -> dict[str, Any]:
        """발화 여러 개의 평균 임베딩 (등록용)."""
        engine, adapter, url, key = self._resolve(mode)
        body = await adapter.enroll(url=url, api_key=key, files=files)
        body["engine"] = engine.id
        return body
