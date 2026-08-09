"""
오디오 필터: dominant_gate — 우세 레벨 상대 게이트.

무엇을 푸는가
-------------
옆에서 TV 나 다른 사람의 말소리가 나면 인식이 쓸 수 없을 만큼 나빠진다.
원인은 절대 임계값이다 — "일정 크기 이상이면 전부" 통과시키므로, 사용자가 말을
쉬는 구간에 TV 소리만 나와도 그것이 STT 로 넘어가고 whisper 가 받아적는다.

    기대: "회의는 내일 오후 세 시에 시작합니다."
    실제: "오늘 서울 지역은 대체로 말했다. 회의는 내일 오후 3시에 시작합니다.
           보통 수준을 유지하겠습니다. 주말에."

**모델을 키워도 해결되지 않는다.** base·small·large-v3 를 모두 시험했고, 큰 모델일수록
배경 TV 를 더 또렷하게 받아적었다. 잡음 제거 필터(afftdn, agate)는 전부 더 나빴다 —
그것들은 "정상 잡음"을 지우는 도구이지 사람 말소리를 지우는 도구가 아니다.

해법: 절대값이 아니라 **그 구간 안에서의 상대값**으로 자른다
------------------------------------------------------------
세그먼트 안에서 "가장 큰 소리"를 우세 레벨(ref)로 잡고, 그보다 `drop_db` 이상 낮은
구간을 0 으로 만든다. 사용자는 마이크에 가깝고 TV 는 멀기 때문에 사용자 음성이
우세하고, TV 만 나오는 구간은 자연히 그보다 낮아 잘려나간다.

이 방식이 성립하는 전제는 하나다 — **말하는 사람이 배경보다 크게 들어온다.**
이어폰 마이크든 노트북 마이크든 거리 차이가 있으면 성립한다. 스피커폰을 방 한가운데
두고 TV 가 더 가까운 상황이라면 성립하지 않는다. 그때는 게이트를 끄는 편이 낫다.

프레임 단위 판정이라 "TV 를 지운다"가 아니라 "사용자가 말하지 않는 동안을 지운다"에
가깝다. 사용자 음성과 TV 가 겹친 구간은 그대로 남는다. 그래도 충분한 이유는,
whisper 가 헛소리를 만들어내는 것은 주로 **말이 없는 구간**을 채우려 할 때이기 때문이다.

실측 (TV만 2초 + 발화 3.2초 + TV만 2초, 사용자가 TV보다 9dB 큼)
----------------------------------------------------------------
    게이트 없음            → TV 내용이 앞뒤로 섞임 (실패)
    drop 6dB, hold 100ms  → "회의는 내일 오후 3시 시작합니다."  ✅
    drop 6dB, hold 180ms  → 같음                                ✅
    drop 6dB, hold 250ms  → 같음                                ✅
    drop 4~5dB            → 불안정 ("저희는", "배이는" 등 오인식)
    drop 7~8dB            → TV 다시 섞임
    hold 400ms            → 유지 구간이 TV 로 이어져 오히려 나빠짐

깨끗한 음성(TV 없음)에는 drop 6dB·8dB 모두 원본과 동일하게 인식됐다.

의존성은 numpy 하나뿐이다. 이 서버는 aarch64 이고 CPU 를 운영 서비스와 나눠 쓴다.
프레임 계산은 전부 벡터 연산이라 수 초짜리 세그먼트에서 밀리초 단위로 끝난다.
"""

from __future__ import annotations

import logging

import numpy as np

from ...registry import register
from ._base import AUDIO_FILTER_KIND, AudioFilterError, FilterResult, need

log = logging.getLogger("audio_filter.dominant_gate")

# int16 을 -1.0~1.0 으로 정규화할 때 쓰는 값. 포맷의 성질이라 설정이 아니다.
_INT16_FULL_SCALE = 32768.0

# log10(0) 을 피하기 위한 하한. int16 의 1 LSB 보다도 훨씬 작아 판정에 영향을 주지 않는다.
# 수치 계산상의 바닥일 뿐이라 설정값이 아니다.
_RMS_FLOOR = 1e-10


@register(AUDIO_FILTER_KIND, "dominant_gate")
class DominantGate:
    def __init__(self, settings: dict, sample_rate: int):
        if sample_rate <= 0:
            raise AudioFilterError(
                "audio_filter.sample_rate_invalid", sample_rate=sample_rate
            )
        self._sr = int(sample_rate)

        g = lambda key: need(settings, key, "dominant_gate")  # noqa: E731

        frame_ms = float(g("frame_ms"))
        if frame_ms <= 0:
            raise AudioFilterError("audio_filter.frame_ms_invalid")
        self._frame = max(1, round(self._sr * frame_ms / 1000.0))
        # 반올림된 프레임 크기로 실제 프레임 길이를 다시 계산한다.
        # 그러지 않으면 hold 길이와 잘라낸 길이 보고가 조금씩 어긋난다.
        self._ms_per_frame = self._frame * 1000.0 / self._sr

        self._drop_db = float(g("drop_db"))
        if self._drop_db <= 0:
            raise AudioFilterError("audio_filter.drop_db_invalid")

        hold_ms = float(g("hold_ms"))
        if hold_ms < 0:
            raise AudioFilterError("audio_filter.hold_ms_invalid")
        self._hold_frames = int(round(hold_ms / self._ms_per_frame))

        top = float(g("reference_top_percent"))
        if not 0 < top <= 100:
            raise AudioFilterError("audio_filter.reference_top_invalid", value=top)
        # numpy 의 percentile 은 "아래에서부터"라 상위 5% → 95 분위수가 된다.
        self._ref_percentile = 100.0 - top

        min_ms = float(g("min_duration_ms"))
        if min_ms < 0:
            raise AudioFilterError("audio_filter.min_duration_invalid")
        self._min_frames = max(1, int(round(min_ms / self._ms_per_frame)))

    # ---- 계약 -------------------------------------------------------------

    def apply(self, pcm: np.ndarray) -> FilterResult:
        """int16 mono 배열을 받아 같은 길이의 배열을 돌려준다. 자르지 않고 0 으로 만든다."""
        if pcm.dtype != np.int16:
            pcm = pcm.astype(np.int16, copy=False)
        if pcm.ndim != 1:
            pcm = pcm.reshape(-1)

        count = pcm.size // self._frame
        if count < self._min_frames:
            # 판단 근거가 없을 만큼 짧다. 손대지 않는 것이 맞다 —
            # 짧은 대답("네")까지 우세 레벨을 잡겠다고 건드리면 잃을 것만 있다.
            return FilterResult(
                pcm=pcm,
                applied=False,
                metrics={"gate_skipped": "too short"},
            )

        signal = pcm[: count * self._frame].astype(np.float32) / _INT16_FULL_SCALE
        frames = signal.reshape(count, self._frame)
        rms = np.sqrt(np.mean(frames * frames, axis=1))
        db = 20.0 * np.log10(np.maximum(rms, _RMS_FLOOR))

        # 우세 레벨: 상위 N% 프레임 dB 의 중앙값.
        # 최댓값 하나가 아니라 중앙값을 쓰는 이유는, 마이크를 툭 친 한 프레임이
        # 기준을 통째로 끌어올려 발화 전체를 잘라버리는 사고를 막기 위해서다.
        cut = float(np.percentile(db, self._ref_percentile))
        top = db[db >= cut]
        ref = float(np.median(top)) if top.size else float(np.max(db))

        keep = db >= (ref - self._drop_db)

        # hold: 유지 구간이 끊긴 뒤 hold_frames 동안은 계속 유지한다.
        # 음절 사이의 짧은 저에너지 구간(파열음 앞 폐쇄, 종결어미의 꼬리)을 지키는 장치다.
        if self._hold_frames > 0 and keep.any():
            index = np.arange(count)
            last_kept = np.maximum.accumulate(np.where(keep, index, -1))
            held = (last_kept >= 0) & ((index - last_kept) <= self._hold_frames)
        else:
            held = keep

        kept_frames = int(held.sum())
        if kept_frames == count:
            # 잘라낼 것이 없다. 깨끗한 음성이 여기로 온다.
            return FilterResult(
                pcm=pcm,
                applied=False,
                metrics=self._metrics(ref, count, kept_frames, pcm.size),
            )

        out = pcm.copy()
        mask = np.repeat(held, self._frame)
        out[: count * self._frame][~mask] = 0
        # 프레임을 못 채운 꼬리는 마지막 프레임의 판정을 따른다.
        if pcm.size > count * self._frame and not held[-1]:
            out[count * self._frame:] = 0

        return FilterResult(
            pcm=out,
            applied=True,
            metrics=self._metrics(ref, count, kept_frames, pcm.size),
        )

    # ---- 관측 -------------------------------------------------------------

    def _metrics(self, ref_db: float, count: int, kept: int, samples: int) -> dict:
        """
        튜닝의 근거가 되는 숫자들.

        gate_kept_pct 가 100 에 가까우면 게이트가 사실상 아무 일도 하지 않은 것이고
        (조용한 환경), 20~60% 면 배경음이 있는 구간을 걷어낸 것이다. 30% 밑으로
        떨어지는데 인식까지 나빠졌다면 drop_db 가 너무 작아 발화를 갉아먹고 있는 것이다.
        """
        return {
            "gate_kept_pct": round(kept * 100.0 / count, 1),
            "gate_removed_ms": int(round((count - kept) * self._ms_per_frame)),
            "gate_ref_db": round(ref_db, 1),
            "gate_input_ms": int(round(samples * 1000.0 / self._sr)),
        }
