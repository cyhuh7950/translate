"""
화자 식별: voice_print — 등록해 둔 목소리와 대조한다.

사용자 요구 두 가지가 같은 기술로 풀린다 (DESIGN.md "음성 등록").

    ① 양방향 통역 — 두 사람이 한 기기로 말할 때 누가 말했는지 알아야 한다
    ② 배경 화자 거부 — 옆에서 TV·다른 사람이 말해도 무시해야 한다

발화의 임베딩을 등록된 임베딩들과 재서, 가장 가까운 사람이 임계값을 넘으면 그 사람의
발화로 보고, 아무도 못 넘으면 등록되지 않은 목소리로 본다. 임베딩은 엔진에서 L2
정규화돼 나오므로 **내적이 곧 코사인 유사도다.**

이 파일이 하는 일과 하지 않는 일
--------------------------------
여기서는 "얼마나 닮았는가"까지만 낸다. 그 숫자로 무엇을 할지는 정책이 정한다
(`app/core/adapters/speaker_policy/`). 같은 대조 결과를 두고 원하는 동작이 상황마다
정반대이기 때문이다 — 회의실에서는 미등록 목소리를 버려야 하고, 통역기에서는
그 미등록 목소리가 바로 대화 상대다.

비동기인 이유
------------
화자 임베딩 엔진을 HTTP 로 불러야 한다. `manual` 은 계산이 없어 동기 함수이고,
두 모양을 함께 받아들이는 방법은 `_base.identify()` 에 있다.

거부는 오류가 아니다
--------------------
등록되지 않은 목소리로 판정되면 `Decision(speaker=None, reason=...)` 을 돌려준다.
예외를 던지지 않는다 — 파이프라인은 인식된 텍스트가 비었을 때와 똑같이 그 세그먼트를
조용히 건너뛰고, 사유는 metrics 와 WS 이벤트로 나간다.

★ 임베딩은 생체정보에 준하는 값이다. 로그에도 응답에도 벡터 자체를 내보내지 않는다.
"""

from __future__ import annotations

import inspect
import logging
from typing import Any, Sequence

import numpy as np

from ... import registry
from ...registry import register
from ..speaker_policy._base import (
    ENGINE_FAILED,
    NO_AUDIO,
    NO_ENROLLED_SPEAKERS,
    NO_FREE_PARTICIPANT,
    SPEAKER_POLICY_KIND,
    UNENROLLED,
    Match,
)
from ._base import (
    SPEAKER_ID_KIND,
    Decision,
    IdentifyContext,
    SpeakerIdError,
    Utterance,
    by_hint,
    input_ids,
)

log = logging.getLogger("voice_print")

# 판정 근거 — metrics 의 speaker_source 로 나간다
FROM_ENROLLED = "enrolled"      # 파일에 명시적으로 등록된 목소리
FROM_LEARNED = "learned"        # 세션 중 자동으로 배운 목소리
FROM_AUTO = "auto_enrolled"     # 방금 자동 등록하면서 배정한 발화
FROM_FREE_SLOT = "unenrolled_slot"   # 등록되지 않았지만 남은 참여자 자리로 배정
FROM_FALLBACK = "fallback"      # 오디오를 보지 않고 정함 (policy: off)


class Recognition:
    """
    한 발화에 대한 대조 작업.

    엔진 호출은 `match()` 안에서 **한 번만** 일어나고 결과는 캐시된다. 정책이
    `match()` 를 부르지 않으면 엔진은 아예 호출되지 않는다 — `off` 정책이 등록
    기능이 없던 때와 같은 비용이 되는 것이 이 성질 덕분이다.
    """

    def __init__(
        self,
        ctx: IdentifyContext,
        participants: Sequence[dict],
        *,
        hint: str | None,
        audio: Utterance | None,
    ):
        self.ctx = ctx
        self.participants = list(participants)
        self.ids = input_ids(self.participants)
        self.hint = hint or None
        self.audio = audio
        self._match: Match | None = None

    # ---- 설정 -------------------------------------------------------------

    @property
    def policy_name(self) -> str:
        return str(self.ctx.config.get("speaker_id.policy"))

    @property
    def threshold(self) -> float:
        return float(self.ctx.config.get("speaker_id.threshold"))

    def _auto_state(self) -> str:
        """
        자동 등록이 지금 가능한가.

        HTTP 배치는 요청마다 독립이라 "세션에서 처음 나온 목소리"라는 개념이 성립하지
        않는다. 그렇다고 배운 것을 파일에 남기면 동의 없이 목소리를 저장하게 되므로,
        그 경로에서는 자동 등록을 하지 않고 이유를 지표로 남긴다.
        """
        if not bool(self.ctx.config.get("speaker_id.auto_enroll.enabled")):
            return "off"
        if self.ctx.voices is None:
            return "unavailable"
        return "on"

    # ---- 후보 -------------------------------------------------------------

    def _known(self) -> list[tuple[str, np.ndarray, str]]:
        """
        지금 알고 있는 목소리들 — (참여자 id, 벡터, 근거).

        이 세션의 입력 참여자에 해당하는 것만 후보가 된다. 다른 프로필에서 등록한
        id 는 이번 세션의 참여자가 아니므로 비교 대상이 아니다.
        """
        out: list[tuple[str, np.ndarray, str]] = []
        store = self.ctx.store
        if store is not None:
            for pid in self.ids:
                vp = store.get(pid)
                if vp is not None:
                    out.append((pid, vp.vector(), FROM_ENROLLED))
        voices = self.ctx.voices
        if voices is not None:
            for pid, vec in voices.items():
                if pid in self.ids:
                    out.append((pid, vec, FROM_LEARNED))
        return out

    def _assigned(self) -> set[str]:
        """이미 목소리가 붙어 있는 참여자들."""
        return {pid for pid, _, _ in self._known()}

    def _free(self) -> list[str]:
        """아직 아무 목소리도 붙지 않은 입력 참여자들. hint 가 있으면 그것을 앞세운다."""
        assigned = self._assigned()
        free = [pid for pid in self.ids if pid not in assigned]
        if self.hint and self.hint in free:
            return [self.hint] + [pid for pid in free if pid != self.hint]
        return free

    # ---- 대조 -------------------------------------------------------------

    async def match(self) -> Match:
        if self._match is None:
            self._match = await self._compute()
        return self._match

    async def _compute(self) -> Match:
        known = self._known()
        auto = self._auto_state()

        # 아무도 등록돼 있지 않고 배울 생각도 없으면 엔진을 부를 이유가 없다.
        # 등록 기능을 켜기 전과 완전히 같은 경로로 떨어진다.
        if not known and auto != "on":
            return Match(reason=NO_ENROLLED_SPEAKERS)

        if self.audio is None or not self.audio.data:
            return Match(reason=NO_AUDIO)

        try:
            body = await self.ctx.engine.embed(
                mode=self.ctx.mode,
                data=self.audio.data,
                filename=self.audio.filename,
                content_type=self.audio.content_type,
            )
        except Exception as exc:
            # 엔진이 죽었다고 통역이 통째로 실패하지는 않는다. 정책이 판단하도록
            # "판정 못 함"으로 넘기고, 이유는 지표에 남긴다 (strict 는 닫히고,
            # enrolled_first 는 열린다 — 각 정책의 성격 그대로다).
            log.warning("Speaker embedding failed: %s: %s", type(exc).__name__, exc)
            return Match(
                reason=ENGINE_FAILED,
                detail={"speaker_engine_error": f"{type(exc).__name__}: {exc}"},
            )

        vec: np.ndarray = body["vector"]
        duration = float(body.get("duration") or 0.0)
        detail: dict[str, Any] = {"speaker_engine": body.get("engine")}

        best: str | None = None
        best_sim: float | None = None
        best_source: str | None = None
        for pid, known_vec, source in known:
            sim = float(np.dot(vec, known_vec))
            if best_sim is None or sim > best_sim:
                best, best_sim, best_source = pid, sim, source

        if best is not None and best_sim is not None and best_sim >= self.threshold:
            # 세션에서 배운 목소리라면 이번 발화로 평균을 다듬는다. 표본이 늘수록
            # 임베딩이 안정된다 (설정한 발화 수를 채우면 더 갱신하지 않는다).
            if best_source == FROM_LEARNED and self.ctx.voices is not None:
                self.ctx.voices.learn(best, vec)
            return Match(
                speaker=best,
                similarity=best_sim,
                closest=best,
                source=best_source,
                detail=detail,
            )

        # 아무와도 맞지 않았다. 자동 등록이 가능하면 빈 참여자 자리에 배운다.
        if auto == "on":
            floor = float(self.ctx.config.get("speaker_id.auto_enroll.min_utterance_s"))
            free = self._free()
            if not free:
                detail["speaker_auto_enroll"] = "skipped (every participant already has a voice)"
            elif duration < floor:
                detail["speaker_auto_enroll"] = (
                    f"skipped (utterance {duration:.2f}s is shorter than {floor:g}s)"
                )
            else:
                pid = free[0]
                count = self.ctx.voices.learn(pid, vec)
                detail["speaker_auto_enroll"] = f"learned '{pid}' (utterance {count})"
                return Match(
                    speaker=pid,
                    similarity=best_sim,
                    closest=best,
                    source=FROM_AUTO,
                    detail=detail,
                )

        return Match(
            similarity=best_sim,
            closest=best,
            reason=UNENROLLED if known else NO_ENROLLED_SPEAKERS,
            detail=detail,
        )

    # ---- 정책이 쓰는 것 -----------------------------------------------------

    def fallback(self) -> Decision:
        """오디오를 보지 않는 판정. `manual` 과 같은 규칙이다."""
        return Decision(
            speaker=by_hint(self.participants, self.hint),
            detail={"speaker_policy": self.policy_name, "speaker_source": FROM_FALLBACK},
        )

    def assign_unenrolled(self, match: Match) -> Decision:
        """
        등록되지 않은 목소리를 남은 참여자에게 배정한다.

        남은 자리가 없으면 그때는 버린다 — 참여자가 모두 채워진 뒤에도 아무와
        맞지 않는 목소리는 제3의 화자(TV·행인)라는 뜻이기 때문이다.
        """
        free = self._free()
        if not free:
            # 엔진 실패·오디오 없음처럼 대조 자체를 못 한 경우에는 그 이유를 그대로
            # 살린다. 자리가 없다는 사실만 남기면 진짜 원인이 지워진다.
            blocked = match.reason in (ENGINE_FAILED, NO_AUDIO)
            return Decision(
                speaker=None,
                reason=match.reason if blocked else NO_FREE_PARTICIPANT,
                detail=self.detail(match),
            )
        return Decision(
            speaker=free[0],
            detail={**self.detail(match), "speaker_source": FROM_FREE_SLOT},
        )

    def detail(self, match: Match) -> dict:
        """metrics 에 얹을 관측값. 임계값을 함께 내보내야 숫자를 해석할 수 있다."""
        out: dict[str, Any] = {
            "speaker_policy": self.policy_name,
            "speaker_threshold": self.threshold,
            "speaker_enrolled": len(self._known()),
            "speaker_auto_enroll": self._auto_state(),
            **match.detail,
        }
        if match.similarity is not None:
            out["speaker_similarity"] = round(match.similarity, 4)
        if match.closest:
            out["speaker_closest"] = match.closest
        if match.source:
            out["speaker_source"] = match.source
        return out


@register(SPEAKER_ID_KIND, "voice_print")
async def voice_print(
    participants: Sequence[dict],
    *,
    hint: str | None = None,
    audio: Utterance | None = None,
    text: str | None = None,
    ctx: IdentifyContext | None = None,
    **_: Any,
) -> Decision:
    """등록된 목소리와 대조하고, 그 결과를 정책에 넘겨 판정을 받는다."""
    if ctx is None or ctx.config is None:
        raise SpeakerIdError("speaker.needs_pipeline_context", status=500)

    recognition = Recognition(ctx, participants, hint=hint, audio=audio)
    policy = registry.resolve(SPEAKER_POLICY_KIND, recognition.policy_name)
    decision = policy(recognition)
    if inspect.isawaitable(decision):
        decision = await decision
    return decision
