"""
화자 식별 어댑터의 공통 계약.

밑줄로 시작하므로 registry.discover() 가 건너뛴다 — 여기에는 구현이 없고 계약만 있다.
구현은 같은 폴더의 `manual.py`, `voice_print.py` … 이고, 새 방식은 파일 하나를 더
넣는 것으로 끝난다.

계약
----

    result = await identify(
        name,                      # 세션의 speaker_id (설정에서 온 이름)
        participants,              # 참여자 목록 (input=True 인 것만 후보)
        hint=...,                  # 클라이언트가 지정한 발화자 id (없으면 None)
        audio=Utterance(...),      # 이번 발화의 오디오 (없을 수 있다)
        text=...,                  # STT 결과 (구현에 따라 사용)
        ctx=IdentifyContext(...),  # 엔진·저장소 등 구현이 필요로 하는 것들
    )                              # → Decision

구현체가 받아들이는 두 가지 모양
--------------------------------
동기 함수와 코루틴을 **둘 다** 허용한다. `manual` 은 계산이 없어 동기로 충분하고,
`voice_print` 는 화자 임베딩 엔진을 HTTP 로 불러야 하므로 비동기여야 한다.
둘 중 하나로 통일하면 한쪽은 불필요한 비용(동기 구현을 억지로 async 로)이나
불가능(비동기 호출을 동기 함수 안에서)을 떠안는다. 그래서 이 헬퍼가 흡수한다 —
반환값이 awaitable 이면 await 하고, 아니면 그대로 쓴다.

반환값도 두 가지 모양을 받는다. 참여자 id 문자열이면 "이 사람이 말했다"로 보고,
`Decision` 이면 거부 사유와 관측값까지 함께 온 것으로 본다.
어느 쪽이든 호출자는 `Decision` 하나만 다룬다.

거부는 오류가 아니다
--------------------
등록되지 않은 목소리로 판정되면 `Decision(speaker=None, reason=...)` 을 돌려준다.
예외를 던지지 않는다 — 옆에서 TV 가 말하는 것은 시스템의 오류가 아니라 정상적인
입력이고, 그때 파이프라인이 할 일은 조용히 그 세그먼트를 건너뛰는 것뿐이다.
(인식된 텍스트가 비었을 때와 같은 처리다. modules/translate/pipeline.py 를 볼 것)

예외는 **설정이나 요청이 잘못됐을 때만** 던진다 (`SpeakerIdError`).
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Sequence

from ... import registry
from ...errors import AppError, listing

# 레지스트리에 등록되는 종류 이름. 새 구현은 이 폴더에 파일 하나를 넣으면 끝난다.
SPEAKER_ID_KIND = "speaker_id"


class SpeakerIdError(AppError):
    """식별을 시도조차 할 수 없다 — 설정이나 요청이 잘못됐다."""

    default_code = "speaker.unresolved"
    default_status = 400


@dataclass
class Utterance:
    """
    식별에 쓸 오디오. 파이프라인이 STT 에 넘기는 것과 **같은 바이트**다.

    별도의 형식으로 변환하지 않는 이유는 엔진이 컨테이너를 알아서 풀기 때문이고,
    같은 바이트를 쓰면 "STT 가 들은 것"과 "화자 판정이 들은 것"이 어긋날 수 없기 때문이다.
    """

    data: bytes
    filename: str
    content_type: str


@dataclass
class IdentifyContext:
    """
    구현이 필요로 하는 주변 것들.

    타입을 느슨하게(Any) 둔 것은 의도적이다. 어댑터 계층이 앱 내부 모듈에
    직접 묶이면 어댑터를 갈아끼우는 의미가 줄어든다.

        config   Config
        engine   voiceprints.SpeakerEngine — 화자 임베딩 엔진 호출부
        store    voiceprints.VoicePrintStore — 명시적 등록 (파일)
        voices   voiceprints.SessionVoices — 자동 등록 (메모리). 세션이 없으면 None
        mode     엔진 라우팅에 쓰는 세션 모드
    """

    config: Any
    engine: Any = None
    store: Any = None
    voices: Any = None
    mode: str = ""


@dataclass
class Decision:
    """
    판정 결과.

    speaker  발화자 참여자 id. **None 이면 이 발화를 처리하지 않는다** (거부).
    reason   None 일 때 왜 그랬는지. metrics 와 WS 이벤트에 그대로 실린다.
    detail   관측값(유사도·임계값·근거). metrics 에 얹혀 튜닝의 근거가 된다.
    """

    speaker: str | None
    reason: str | None = None
    detail: dict = field(default_factory=dict)


def input_ids(participants: Sequence[dict]) -> list[str]:
    """입력을 받는 참여자 id 들. 후보는 항상 이 목록이다."""
    ids = [p["id"] for p in participants if p.get("input")]
    if not ids:
        raise SpeakerIdError("speaker.no_input_participant")
    return ids


def by_hint(participants: Sequence[dict], hint: str | None) -> str:
    """
    오디오를 보지 않고 정하는 규칙 — 클라이언트가 지정했거나, 후보가 하나뿐일 때.

    `manual` 구현의 본체이고, 화자 식별에 관여하지 않는 정책(`off`)도 같은 규칙을 쓴다.
    정할 수 없으면 SpeakerIdError 를 던진다.
    """
    ids = input_ids(participants)

    if hint:
        if hint not in ids:
            raise SpeakerIdError("speaker.hint_not_input", hint=hint, available=listing(ids))
        return hint

    if len(ids) == 1:
        return ids[0]

    raise SpeakerIdError("speaker.ambiguous", available=listing(ids))


def static_speaker(participants: Sequence[dict], hint: str | None) -> str | None:
    """
    오디오 없이도 확실한 발화자. 정할 수 없으면 None (예외를 던지지 않는다).

    아직 오디오가 없는 시점의 이벤트(vad, ready, error)에 붙는 from/to 를 만들 때 쓴다.
    그런 이벤트 하나 때문에 엔진을 부르거나 연결을 끊을 수는 없기 때문이다.
    """
    try:
        return by_hint(participants, hint)
    except SpeakerIdError:
        return None


async def identify(
    name: str,
    participants: Sequence[dict],
    *,
    hint: str | None = None,
    audio: Utterance | None = None,
    text: str | None = None,
    ctx: IdentifyContext | None = None,
) -> Decision:
    """이름으로 구현을 찾아 부르고, 동기/비동기와 두 가지 반환 모양을 흡수한다."""
    impl = registry.resolve(SPEAKER_ID_KIND, name)
    outcome = impl(participants, hint=hint, audio=audio, text=text, ctx=ctx)
    if inspect.isawaitable(outcome):
        outcome = await outcome

    if isinstance(outcome, Decision):
        return outcome
    if isinstance(outcome, str) and outcome:
        return Decision(speaker=outcome)
    raise SpeakerIdError(
        "speaker.bad_return", status=500, implementation=name, type=type(outcome).__name__
    )
