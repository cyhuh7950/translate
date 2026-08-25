"""
사용자 저장소 — 이름/별칭 + PIN. 계정 가입이 아니라 "누가 쓰고 있는가"를 가르는 정도다.

DESIGN.md §15 — 개인 서비스로 시작한 서버를 여러 사람이 같이 쓴다는 것이 드러나면서
화자 등록·STT 개인화·번역 이력·언어 학습을 사람 단위로 나눌 근거가 필요해졌다.
1단계는 테넌트를 만들지 않는다(서버 전체가 암묵적으로 테넌트 1개). 여기서 만드는
것은 그 서버 안에서 "이 사람"을 가리키는 최소한의 식별자뿐이다. 화자 등록을
`user_id` 로 나누는 일, `lang_learn` 모듈이 이 저장소를 참조하는 일은 다음 단계다
(PLAN_LANG_LEARN.md 서버 작업 2·3번) — 여기서는 CRUD 만 한다.

저장 방식은 `voiceprints.py` 의 `VoicePrintStore` 를 그대로 따른다. JSON 파일 하나 +
스레드 락 + 원자적 교체. 사용자 몇 명 수준에서 별도 DB 를 새로 들이는 비용이 더 크고,
이미 이 서버의 다른 저장소(화자 등록)가 같은 방식으로 잘 돌고 있으니 규약을 갈라 둘
이유가 없다.

★ PIN 은 인증 정보다. 평문으로도, 되돌릴 수 있는 형태로도 저장하지 않는다.
  `hashlib.pbkdf2_hmac` 로 사용자마다 다른 솔트를 섞어 늘린 해시만 남긴다(아래
  `_hash_pin`/`_verify_pin`). 이 프로젝트에 이미 있는 해시 유틸은 없었다(grep 확인)
  — 표준 라이브러리만으로 되는 pbkdf2 를 새로 골랐다. bcrypt/argon2 같은 전용
  라이브러리를 넣지 않은 이유는 依存성 하나를 늘릴 만큼 이 서버의 위협 모델이
  크지 않기 때문이다(개인/소수 사용자 서버, 온라인 무차별대입 정도만 막으면 된다).
"""

from __future__ import annotations

import hashlib
import hmac
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

log = logging.getLogger("users")

# 저장 파일 포맷 버전. 형식이 바뀌면 올리고, 읽는 쪽이 판단할 근거로 쓴다.
STORE_VERSION = 1

# pin_hash 문자열의 알고리즘 태그. 나중에 반복 횟수나 알고리즘을 바꿔도(설정값은
# 바뀌어도) 예전에 저장된 해시를 여전히 검증할 수 있어야 하므로 태그와 반복 횟수를
# 해시 문자열 자체에 싣는다 — 검증 시점의 설정이 아니라 저장 시점의 것을 쓴다.
PBKDF2_TAG = "pbkdf2_sha256"


class UserError(AppError):
    """사용자 저장소를 읽거나 쓰지 못했다, 또는 등록/로그인 입력이 잘못됐다."""

    default_code = "users.failed"
    default_status = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _hash_pin(pin: str, *, iterations: int) -> str:
    """`pbkdf2_sha256$<반복횟수>$<솔트 hex>$<해시 hex>` 형태로 만든다."""
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, iterations)
    return f"{PBKDF2_TAG}${iterations}${salt.hex()}${digest.hex()}"


def _verify_pin(pin: str, stored: str) -> bool:
    """저장된 해시 문자열에 실린 알고리즘·반복횟수·솔트로 다시 계산해 비교한다."""
    try:
        tag, iterations_s, salt_hex, digest_hex = stored.split("$", 3)
        if tag != PBKDF2_TAG:
            return False
        salt = bytes.fromhex(salt_hex)
        want = bytes.fromhex(digest_hex)
    except (ValueError, TypeError):
        # 저장된 값이 이 포맷이 아니다 — 손상됐거나 다른 방식으로 만들어진 것이다.
        # 여기서 죽지 않는다. "그냥 틀린 PIN"과 같은 결과(거부)로 처리한다.
        return False
    got = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, int(iterations_s))
    # 타이밍 공격을 피하려고 길이·내용 비교를 상수 시간으로 한다.
    return hmac.compare_digest(got, want)


# ---------------------------------------------------------------------------
# 사용자 하나
# ---------------------------------------------------------------------------


@dataclass
class User:
    id: str
    name: str
    pin_hash: str
    created_at: str

    def public(self) -> dict:
        """클라이언트에 내보내는 형태. **pin_hash 는 절대 넣지 않는다.**"""
        return {"id": self.id, "name": self.name, "created_at": self.created_at}


# ---------------------------------------------------------------------------
# 파일 저장소
# ---------------------------------------------------------------------------


class UserStore:
    """
    사용자들을 JSON 파일 하나에 담는다. `voiceprints.py` 의 `VoicePrintStore` 와 같은 규칙.

    경로는 설정(`users.store_path`)에서 온다. `config/` 는 읽기전용으로 마운트되므로
    쓰기 가능한 볼륨(compose 의 `../data` → `/data`)을 화자 등록 저장소와 같이 쓴다.

    파일이 없으면 빈 저장소로 시작한다 — 아직 아무도 등록하지 않은 상태가 정상이다.
    파일이 깨져 있으면 **빈 상태로 시작하되 쓰기를 막는다.** 깨진 파일을 조용히
    덮어써서 남은 계정까지 날리는 것이 가장 나쁜 결과이기 때문이다.
    """

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._lock = threading.RLock()
        self._users: dict[str, User] = {}       # id -> User
        self._by_name: dict[str, str] = {}       # 이름(소문자) -> id, 중복 이름 판정용
        self._path: Path | None = None
        self._error: str | None = None
        self._ensure()

    # ---- 로딩 -------------------------------------------------------------

    def _configured_path(self) -> Path:
        return Path(str(self._cfg.get("users.store_path")))

    def _ensure(self) -> None:
        """설정의 경로가 바뀌었으면 다시 읽는다. 설정 핫 리로드를 따라가기 위한 것이다."""
        path = self._configured_path()
        with self._lock:
            if path != self._path:
                self._path = path
                self._load()

    def _load(self) -> None:
        path = self._path
        self._users = {}
        self._by_name = {}
        self._error = None
        if path is None or not path.exists():
            log.info("User store is empty (no file yet at %s)", path)
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for item in raw.get("users") or []:
                user = User(
                    id=str(item["id"]),
                    name=str(item["name"]),
                    pin_hash=str(item["pin_hash"]),
                    created_at=str(item.get("created_at") or ""),
                )
                self._users[user.id] = user
                self._by_name[user.name.casefold()] = user.id
        except Exception as exc:
            # 여기서 죽지 않는다. 대신 쓰기를 막아 남은 파일을 지키고, 이유를 남긴다.
            self._users = {}
            self._by_name = {}
            self._error = f"{type(exc).__name__}: {exc}"
            log.error("Could not read the user store %s: %s", path, self._error)
            return
        log.info("Loaded %d user(s) from %s", len(self._users), path)

    def _save(self) -> None:
        path = self._path
        if path is None:
            raise UserError("users.store_not_configured")
        if self._error:
            raise UserError("users.store_unreadable", path=path, reason=self._error)
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {
            "version": STORE_VERSION,
            # 파일을 직접 열어본 사람에게도 이것이 무엇인지 알려둔다.
            "note": (
                "User accounts (name + PIN hash). PINs are hashed with salted PBKDF2 and "
                "cannot be recovered from this file, but treat it as sensitive: do not "
                "copy or share it."
            ),
            "updated_at": _now(),
            "users": [
                {
                    "id": u.id,
                    "name": u.name,
                    "pin_hash": u.pin_hash,
                    "created_at": u.created_at,
                }
                for u in self._users.values()
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

    def get(self, user_id: str) -> User | None:
        self._ensure()
        with self._lock:
            return self._users.get(user_id)

    def find_by_name(self, name: str) -> User | None:
        self._ensure()
        with self._lock:
            user_id = self._by_name.get(name.casefold())
            return self._users.get(user_id) if user_id else None

    def count(self) -> int:
        self._ensure()
        with self._lock:
            return len(self._users)

    def status(self) -> dict:
        """/v1/config 에 얹을 수 있는 상태. pin_hash 는 들어가지 않는다."""
        self._ensure()
        with self._lock:
            return {"count": len(self._users), "path": str(self._path), "error": self._error}

    # ---- 변경 -------------------------------------------------------------

    def create(self, *, name: str, pin: str) -> User:
        """새 사용자를 만든다. 이름은 대소문자 구분 없이 서버 안에서 유일해야 한다."""
        name = name.strip()
        pin = pin.strip()
        if not name:
            raise UserError("users.name_required", status=400)
        min_len = int(self._cfg.get("users.pin_min_length"))
        if len(pin) < min_len:
            raise UserError("users.pin_too_short", status=400, minimum=min_len)

        self._ensure()
        with self._lock:
            if name.casefold() in self._by_name:
                raise UserError("users.name_taken", status=400, name=name)
            iterations = int(self._cfg.get("users.pbkdf2_iterations"))
            user = User(
                id=uuid.uuid4().hex,
                name=name,
                pin_hash=_hash_pin(pin, iterations=iterations),
                created_at=_now(),
            )
            self._users[user.id] = user
            self._by_name[user.name.casefold()] = user.id
            self._save()
        log.info("Registered user '%s' (%s)", user.name, user.id)
        return user

    def authenticate(self, *, name: str, pin: str) -> User:
        """이름+PIN 이 맞으면 그 사용자, 아니면 `users.invalid_credentials`.

        이름이 없는 경우와 PIN 이 틀린 경우를 **같은 오류·같은 상태 코드**로 돌려준다.
        둘을 구분해 알려주면 "등록된 이름 찾기"에 쓰일 수 있기 때문이다.
        """
        user = self.find_by_name(name.strip())
        if user is None or not _verify_pin(pin.strip(), user.pin_hash):
            raise UserError("users.invalid_credentials", status=401)
        return user
