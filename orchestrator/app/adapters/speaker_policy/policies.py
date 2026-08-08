"""
화자 등록 정책 3종.

정책 이름은 `speaker_id.policy` 로 고른다. 새 정책은 이 폴더에 파일을 하나 더 넣고
@register 하면 되고, 이 파일을 열 필요는 없다. 계약은 `_base.py` 에 있다.
"""

from __future__ import annotations

from ...registry import register
from ..speaker_id._base import Decision
from ._base import SPEAKER_POLICY_KIND, UNENROLLED


@register(SPEAKER_POLICY_KIND, "off")
def off(rec) -> Decision:
    """
    화자 식별에 관여하지 않는다 — 등록 기능이 없던 때와 완전히 같다.

    `match()` 를 부르지 않으므로 화자 임베딩 엔진도 호출되지 않는다.
    판정은 `manual` 과 같은 규칙(hint, 또는 후보가 하나뿐)으로 떨어진다.
    """
    return rec.fallback()


@register(SPEAKER_POLICY_KIND, "strict")
async def strict(rec) -> Decision:
    """
    등록된 목소리만 받는다. 임계값을 넘지 못하면 버린다.

    배경 화자 거부가 목적이다 — 옆에서 TV 나 다른 사람이 말해도 통역하지 않는다.
    등록된 화자가 하나도 없으면 **전부 거부된다.** 그것이 이 정책의 정의이므로
    조용히 완화하지 않는다. 사유는 metrics 와 이벤트로 나가므로 왜 아무것도
    통역되지 않는지가 드러난다.

    대신 자동 등록이 켜져 있으면 그 학습분도 "등록된 목소리"로 친다.
    처음 두 사람을 배우고 그 뒤로 들어오는 제3의 목소리를 거부하는 형태가 된다.
    """
    match = await rec.match()
    if match.speaker:
        return Decision(speaker=match.speaker, detail=rec.detail(match))
    return Decision(
        speaker=None,
        reason=match.reason or UNENROLLED,
        detail=rec.detail(match),
    )


@register(SPEAKER_POLICY_KIND, "enrolled_first")
async def enrolled_first(rec) -> Decision:
    """
    기본값. 등록된 목소리는 누구인지 식별하고, 등록 안 된 목소리는 **버리지 않는다.**

    통역기는 처음 만난 사람과 대화하려고 쓰는 물건이다. 내 목소리만 등록해 두면
    나는 정확히 식별되고, 상대방(등록될 리 없는 사람)의 말은 남은 참여자 자리로
    들어가 그대로 통역된다.

    참여자 자리가 이미 전부 차 있는데 아무와도 맞지 않는 목소리라면 그때는 버린다 —
    그 시점에는 그것이 곧 제3의 목소리(TV·행인)라는 뜻이기 때문이다.
    """
    match = await rec.match()
    if match.speaker:
        return Decision(speaker=match.speaker, detail=rec.detail(match))
    return rec.assign_unenrolled(match)
