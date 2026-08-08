"""
화자 식별: manual — 클라이언트가 누가 말했는지 명시한다.

1단계(단방향)에서 쓰던 유일한 구현이다. 발화자를 요청에 담아 보내므로 추론이 필요 없고,
후보가 하나뿐이면 hint 없이도 정해진다.

계약과 공통 규칙은 `_base.py` 에 있다. 이 파일은 그 규칙을 그대로 쓰는 얇은 등록부다.
같은 폴더의 `voice_print.py` 는 오디오를 보고 판정하는 비동기 구현이다 —
두 모양을 어떻게 함께 받아들이는지는 `_base.identify()` 를 볼 것.
"""

from __future__ import annotations

from typing import Any, Sequence

from ...registry import register
from ._base import SPEAKER_ID_KIND, SpeakerIdError, Utterance, by_hint

__all__ = ["SPEAKER_ID_KIND", "SpeakerIdError", "manual"]


@register(SPEAKER_ID_KIND, "manual")
def manual(
    participants: Sequence[dict],
    *,
    hint: str | None = None,
    audio: Utterance | None = None,
    text: str | None = None,
    **_: Any,
) -> str:
    """클라이언트가 준 hint 를 그대로 쓴다. 오디오는 보지 않는다."""
    return by_hint(participants, hint)
