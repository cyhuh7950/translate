"""
세션 프로필과 참여자 모델.

최종 목표는 양방향 통역이고, 단방향은 그 특수 케이스다.
세션은 참여자 목록을 갖고, 참여자 하나는 (언어, 입력 받을지, 누구에게 들려줄지)다.
단방향은 한쪽 참여자의 `input` 을 false 로 둔 것일 뿐이라 코드 경로가 동일하다.

번역 방향은 **발화자의 언어 → 수신자의 언어**로 그때그때 계산된다.
코드에 "ko→en" 같은 상수가 없다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from . import registry
from .adapters.speaker_id.manual import SPEAKER_ID_KIND
from .config import Config, ConfigError
from .i18n import localize

# 프로필 자리표시자는 {{name}} 이다. config.py 의 환경변수 치환(${VAR})과 겹치지 않게
# 일부러 다른 문법을 쓴다 — 겹치면 환경변수 치환이 먼저 빈 문자열로 지워버린다.
_VAR = re.compile(r"\{\{([a-z_]+)\}\}")


class SessionError(Exception):
    pass


@dataclass
class Participant:
    id: str
    lang: str
    input: bool
    output: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"id": self.id, "lang": self.lang, "input": self.input, "output": list(self.output)}


@dataclass
class Session:
    profile: str
    mode: str
    participants: list[Participant]
    speaker_id: str
    turn_policy: str

    def by_id(self, pid: str) -> Participant:
        for p in self.participants:
            if p.id == pid:
                return p
        raise SessionError(f"Unknown participant: '{pid}'")

    def speakers(self) -> list[Participant]:
        return [p for p in self.participants if p.input]

    def listeners_of(self, speaker_id: str) -> list[Participant]:
        """발화자의 output 목록. 여기서 번역 방향이 결정된다."""
        speaker = self.by_id(speaker_id)
        if not speaker.output:
            raise SessionError(
                f"Participant '{speaker_id}' has an empty output, so there is nowhere to deliver to"
            )
        return [self.by_id(pid) for pid in speaker.output]

    def as_dict(self) -> dict:
        return {
            "profile": self.profile,
            "mode": self.mode,
            "participants": [p.as_dict() for p in self.participants],
            "speaker_id": self.speaker_id,
            "turn_policy": self.turn_policy,
        }


def _substitute(value: Any, vars_: dict[str, str]) -> Any:
    """프로필의 {{source_lang}} 등을 세션이 넘긴 값으로 치환한다."""
    if isinstance(value, str):
        def repl(m: re.Match) -> str:
            key = m.group(1)
            if key not in vars_:
                raise SessionError(
                    f"Profile requires a value that was not provided: '{key}'. "
                    f"Available: {', '.join(sorted(vars_)) or '(none)'}"
                )
            return vars_[key]
        return _VAR.sub(repl, value)
    if isinstance(value, dict):
        return {k: _substitute(v, vars_) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute(v, vars_) for v in value]
    return value


class ProfileRegistry:
    """profiles.yaml 을 읽고, 필요한 어댑터가 등록돼 있는지로 가용성을 판단한다."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._profiles: dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        raw = self._cfg.require_section("profiles")
        for name, spec in raw.items():
            if not spec.get("participants"):
                raise ConfigError(f"Profile '{name}' has no participants")
            if not spec.get("speaker_id"):
                raise ConfigError(f"Profile '{name}' has no speaker_id")
        self._profiles = dict(raw)

    def names(self) -> list[str]:
        return list(self._profiles)

    def unavailable_reason(self, name: str) -> str | None:
        """
        이 프로필을 지금 쓸 수 있는지. 못 쓰면 이유를 돌려준다.

        1단계에서 `twoway` 는 language_detect 어댑터가 없어 여기서 걸린다.
        2단계에서 그 파일을 추가하면 코드 수정 없이 켜진다.
        """
        spec = self._profiles.get(name)
        if spec is None:
            return f"Unknown profile: {name}"
        sid = spec["speaker_id"]
        if not registry.has(SPEAKER_ID_KIND, sid):
            return (
                f"Speaker identification implementation '{sid}' is not registered "
                f"(available: {', '.join(registry.available(SPEAKER_ID_KIND)) or 'none'})"
            )
        return None

    def public_view(self, locale: str | None = None) -> list[dict]:
        # label/description 은 설정에서 로케일 맵일 수 있다. 여기서 표시 언어로 푼다.
        out = []
        for name, spec in self._profiles.items():
            reason = self.unavailable_reason(name)
            out.append({
                "id": name,
                "label": localize(spec.get("label", name), locale),
                "description": localize(spec.get("description"), locale),
                "speaker_id": spec["speaker_id"],
                "turn_policy": spec.get("turn_policy"),
                "participant_count": len(spec["participants"]),
                "bidirectional": sum(1 for p in spec["participants"] if p.get("input")) > 1,
                "available": reason is None,
                "reason": reason,
            })
        return out

    def create(
        self,
        *,
        profile: str | None,
        mode: str | None,
        source_lang: str,
        target_lang: str,
        participants: list[dict] | None = None,
    ) -> Session:
        """프로필로 세션을 만든다. participants 를 직접 주면 프로필 없이도 된다."""
        mode = mode or self._cfg.get("session.default_mode")

        if participants is not None:
            # 프로필 없이 참여자를 직접 넘긴 경우. 나머지는 세션 기본값을 따른다.
            spec = {
                "participants": participants,
                "speaker_id": self._cfg.get("session.default_speaker_id"),
                "turn_policy": self._cfg.get("session.default_turn_policy"),
            }
            profile_name = "custom"
        else:
            profile_name = profile or self._cfg.get("session.default_profile")
            reason = self.unavailable_reason(profile_name)
            if reason:
                raise SessionError(f"Profile '{profile_name}' is not usable — {reason}")
            spec = self._profiles[profile_name]

        resolved = _substitute(
            spec["participants"], {"source_lang": source_lang, "target_lang": target_lang}
        )
        parts = [
            Participant(
                id=p["id"],
                lang=p["lang"],
                input=bool(p.get("input", False)),
                output=list(p.get("output") or []),
            )
            for p in resolved
        ]
        if not any(p.input for p in parts):
            raise SessionError("No participant accepts input")

        return Session(
            profile=profile_name,
            mode=mode,
            participants=parts,
            speaker_id=spec["speaker_id"],
            turn_policy=spec.get("turn_policy") or "half_duplex",
        )
