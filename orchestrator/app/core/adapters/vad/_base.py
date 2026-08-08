"""
VAD 어댑터의 공통 계약.

밑줄로 시작하므로 registry.discover() 가 건너뛴다 — 여기에는 구현이 없고 계약만 있다.

계약
----

    vad = registry.resolve(VAD_KIND, cfg.get("vad.backend"))(settings, sample_rate)

    events = vad.push(pcm)     # int16 mono 샘플을 넣고 그동안 발생한 이벤트를 받는다
    events = vad.flush()       # 스트림이 끝났을 때 남아 있는 발화를 확정한다

`push()` 는 **길이가 아무래도 좋은** 배열을 받는다. 네트워크 프레임 크기와 VAD 의
분석 프레임 크기를 분리하기 위해서다. 클라이언트가 20ms 로 보내든 100ms 로 보내든,
심지어 한 프레임이 반 토막으로 도착하든 VAD 는 자기 `frame_ms` 로 다시 자른다.
(원안은 "프레임을 넣는다"였지만, WS 바이너리 프레임이 VAD 프레임에 정렬된다는
보장이 없어 어댑터마다 같은 버퍼링 코드를 반복하게 된다.)

이벤트
------

`speech_start` 는 발화가 시작됐다는 신호일 뿐 오디오를 담지 않는다.
`speech_end` 는 구간 오디오를 담는다. 단 `dropped=True` 면 오디오가 없다 —
`min_speech_ms` 에 못 미쳐 버려진 구간이다. 버려져도 **이벤트는 나간다.**
그래야 화면이 "말하는 중"에서 빠져나온다.

파이프라인은 `dropped` 인 이벤트를 무시하면 된다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

# 레지스트리에 등록되는 종류 이름. 새 백엔드는 이 폴더에 파일을 하나 넣으면 끝난다.
VAD_KIND = "vad"

SPEECH_START = "speech_start"
SPEECH_END = "speech_end"


class VadError(Exception):
    pass


@dataclass
class VadEvent:
    """
    state       speech_start | speech_end
    at_ms       스트림 시작부터의 위치. speech_end 면 구간의 끝
    audio       speech_end 이고 dropped 가 아닐 때만 있는 int16 mono 배열
    duration_ms 구간 길이 (오디오가 있을 때만)
    speech_ms   그중 실제로 유성으로 판정된 길이. min_speech_ms 판정의 근거다
    dropped     너무 짧아 버려졌는가
    reason      확정된 이유 — silence | max_speech | flush | forced
    """

    state: str
    at_ms: int
    audio: np.ndarray | None = None
    duration_ms: int | None = None
    speech_ms: int | None = None
    dropped: bool = False
    reason: str | None = None

    def meta(self) -> dict[str, Any]:
        """WS 이벤트로 내보내는 형태. 오디오 바이트는 빠진다."""
        out: dict[str, Any] = {"state": self.state, "at_ms": self.at_ms}
        for key in ("duration_ms", "speech_ms", "reason"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        if self.state == SPEECH_END:
            out["dropped"] = self.dropped
        return out


def need(settings: dict, key: str, backend: str) -> Any:
    """
    설정값을 꺼낸다. 없으면 죽는다.

    config.get() 에 기본값 인자가 없는 것과 같은 이유다 — 코드가 임의의 값을
    지어내면 "지금 이 값이 어디서 왔는지"를 설정 파일에서 추적할 수 없게 된다.
    """
    if key not in settings:
        raise VadError(
            f"VAD backend '{backend}' requires the '{key}' setting. "
            f"Add it under the vad: section of defaults.yaml "
            f"(present: {', '.join(sorted(settings)) or 'none'})"
        )
    return settings[key]
