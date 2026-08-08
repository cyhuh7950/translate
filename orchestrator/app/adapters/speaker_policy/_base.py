"""
화자 등록 정책의 공통 계약.

밑줄로 시작하므로 registry.discover() 가 건너뛴다 — 계약만 있고 구현은 없다.

무엇을 정하는 층인가
--------------------
`voice_print` 어댑터는 "들어온 목소리가 등록된 것들과 얼마나 닮았는가"까지만 낸다.
그 숫자를 놓고 **무엇을 할지**는 정책이 정한다. 둘을 나눈 이유는, 같은 대조 결과를
두고 원하는 동작이 상황마다 정반대이기 때문이다.

    strict          등록된 목소리만 받는다. 미달이면 버린다
    enrolled_first  등록된 사람은 식별하고, 등록 안 된 목소리는 남은 참여자에게 준다
    off             화자 식별에 관여하지 않는다 (등록 기능이 없던 때와 같다)

기본값이 `enrolled_first` 인 이유는 용도에 있다. 통역기는 **처음 만난 사람**과
대화하려고 쓴다. 상대방은 당연히 등록돼 있지 않으므로, `strict` 를 기본으로 두면
가장 흔한 사용이 통째로 막힌다.

계약
----

    decision = policy(recognition) -> Decision        # 동기/비동기 둘 다 가능

`recognition` 이 제공하는 것 (voice_print.Recognition):

    await recognition.match() -> Match     대조 결과. 엔진 호출은 여기서 한 번만 일어난다
    recognition.fallback()    -> Decision  오디오를 보지 않는 판정 (hint / 후보가 하나)
    recognition.assign_unenrolled(match)   미등록 목소리를 남은 참여자에게 배정
    recognition.detail(match) -> dict      metrics 에 얹을 관측값

`match()` 를 부르지 않으면 화자 임베딩 엔진은 아예 호출되지 않는다. `off` 가
등록 기능이 없던 때와 완전히 같은 비용·같은 동작이 되는 것이 이 성질 덕분이다.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 레지스트리에 등록되는 종류 이름
SPEAKER_POLICY_KIND = "speaker_policy"

# 거부 사유 코드. metrics 의 `skipped` 와 WS 의 speaker.rejected 이벤트에 그대로 실린다.
# 문자열을 코드로 쓰는 이유는 클라이언트가 나중에 자기 카탈로그로 문장을 만들 수 있게
# 하기 위해서다 (DESIGN.md "남은 과제 — 오류 메시지 지역화" 와 같은 방향).
UNENROLLED = "speaker.unenrolled"
NO_ENROLLED_SPEAKERS = "speaker.none_enrolled"
NO_FREE_PARTICIPANT = "speaker.no_unenrolled_participant"
NO_AUDIO = "speaker.no_audio"
ENGINE_FAILED = "speaker.engine_failed"


@dataclass
class Match:
    """
    대조 결과.

    speaker     임계값을 넘은 참여자 id. 넘은 것이 없으면 None
    similarity  가장 가까운 후보와의 코사인 유사도. 후보가 없었으면 None
    closest     가장 가까웠던 참여자 id (임계값을 넘지 못했더라도)
    source      판정 근거: enrolled(파일 등록) | learned(세션 자동 등록) | auto(방금 학습)
    reason      speaker 가 None 인 이유
    detail      관측값
    """

    speaker: str | None = None
    similarity: float | None = None
    closest: str | None = None
    source: str | None = None
    reason: str | None = None
    detail: dict = field(default_factory=dict)
