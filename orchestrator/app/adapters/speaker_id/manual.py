"""
화자 식별: manual — 클라이언트가 누가 말했는지 명시한다.

1단계(단방향)에서 쓰는 유일한 구현이다. 발화자를 요청에 담아 보내므로 추론이 필요 없다.

2단계에서 양방향으로 갈 때는 이 폴더에 `language_detect.py` 를 추가한다.
그때 파이프라인·세션 모델·프로토콜은 손대지 않는다 — 그것이 1단계 설계의 목표다.

계약:
    identify(participants, *, hint, audio, text) -> participant_id
      participants  세션의 참여자 목록 (input=True 인 것만 후보)
      hint          클라이언트가 지정한 발화자 id (없으면 None)
      audio         16kHz mono float32 (구현에 따라 사용)
      text          STT 결과 (구현에 따라 사용)
"""

from __future__ import annotations

from typing import Any, Sequence

from ...registry import register

SPEAKER_ID_KIND = "speaker_id"


class SpeakerIdError(Exception):
    pass


@register(SPEAKER_ID_KIND, "manual")
def manual(
    participants: Sequence[dict],
    *,
    hint: str | None = None,
    audio: Any = None,
    text: str | None = None,
) -> str:
    """클라이언트가 준 hint 를 그대로 쓴다. 후보가 하나뿐이면 hint 없이도 결정된다."""
    speakers = [p for p in participants if p.get("input")]
    if not speakers:
        raise SpeakerIdError("No participant accepts input (all have input: false)")

    ids = [p["id"] for p in speakers]

    if hint:
        if hint not in ids:
            raise SpeakerIdError(
                f"'{hint}' is not an input-accepting participant in this session "
                f"(available: {', '.join(ids)})"
            )
        return hint

    if len(ids) == 1:
        return ids[0]

    raise SpeakerIdError(
        f"Cannot determine the speaker. There are multiple input participants "
        f"({', '.join(ids)}), so specify speaker in the request or register a "
        f"speaker_id implementation that can identify it automatically "
        f"(e.g. language_detect)"
    )
