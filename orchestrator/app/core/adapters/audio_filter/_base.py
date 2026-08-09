"""
오디오 필터 어댑터의 공통 계약.

밑줄로 시작하므로 registry.discover() 가 건너뛴다 — 여기에는 구현이 없고 계약만 있다.

무엇을 하는 층인가
------------------
STT 에 넣기 **직전**의 int16 PCM 을 손보는 자리다. VAD 와 역할이 다르다.

  VAD           "지금 말이 시작/끝났는가" — 세그먼트의 **경계**를 정한다
  audio_filter  그렇게 잘라낸 세그먼트 **안쪽**을 손본다

둘을 나눈 이유는 실측 때문이다. 옆에서 TV 가 나오는 환경에서는 VAD 가 경계를 옳게
잡아도 세그먼트 안의 "말을 쉬는 구간"에 TV 소리가 남고, whisper 는 그것까지
성실하게 받아적는다. 모델을 키우면 오히려 더 또렷하게 받아적는다.

계약
----

    settings = cfg.require_section("audio_filter")
    filt = registry.resolve(AUDIO_FILTER_KIND, cfg.get("audio_filter.implementation"))(
        settings, sample_rate
    )
    out = filt.apply(pcm)        # int16 mono ndarray → FilterResult

`apply()` 는 **길이를 바꾸지 않는다.** 잘라내는 대신 0 으로 만든다.
길이를 바꾸면 진단 사이드카의 위치 정보(start_ms/end_ms)와 VAD 가 본 시간축이
어긋나고, 무엇보다 "게이트를 끄면 완전히 동일하게 동작한다"를 확인하기 어려워진다.

`applied=False` 로 돌려주면 호출자는 **원본을 그대로 쓴다.** 입력이 너무 짧아
판단 근거가 없을 때처럼, 손대지 않는 것이 맞는 경우를 위한 것이다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ...errors import AppError, listing

# 레지스트리에 등록되는 종류 이름. 새 필터는 이 폴더에 파일을 하나 넣으면 끝난다.
AUDIO_FILTER_KIND = "audio_filter"


class AudioFilterError(AppError):
    """필터 설정이 잘못됐거나 입력을 다루지 못했다."""

    default_code = "audio_filter.failed"
    default_status = 500


@dataclass
class FilterResult:
    """
    pcm      필터를 거친 int16 mono 배열. applied 가 False 면 입력 그대로다.
    applied  실제로 손을 댔는가. False 면 호출자는 원본 바이트를 그대로 흘려보낸다.
    metrics  관측용 지표. 그대로 WS 의 metrics 이벤트와 HTTP 응답 metrics 에 얹힌다.
             튜닝은 이 숫자를 보고 하는 것이므로 구현마다 알아서 채운다.
    """

    pcm: np.ndarray
    applied: bool = False
    metrics: dict[str, Any] = field(default_factory=dict)


def need(settings: dict, key: str, name: str) -> Any:
    """
    설정값을 꺼낸다. 없으면 죽는다.

    config.get() 에 기본값 인자가 없는 것과 같은 이유다 — 코드가 임의의 값을
    지어내면 "지금 이 값이 어디서 왔는지"를 설정 파일에서 추적할 수 없게 된다.
    """
    if key not in settings:
        raise AudioFilterError(
            "audio_filter.setting_required",
            implementation=name,
            setting=key,
            present=listing(sorted(settings)),
        )
    return settings[key]
