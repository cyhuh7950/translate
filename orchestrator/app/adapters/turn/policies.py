"""
턴 정책 — 번역 음성이 나가는 중에 들어오는 입력을 어떻게 할 것인가.

실시간 통역에서 가장 까다로운 부분이다. 그대로 두면 스피커 소리가 마이크로 들어가
자기 번역을 다시 번역하는 루프가 생긴다.

정책 이름은 세션 프로필의 `turn_policy` (없으면 `session.default_turn_policy`)로
정해지고, 여기 등록된 이름 중에서 찾는다. `barge_in` 처럼 새 정책을 넣고 싶으면
이 폴더에 파일을 하나 더 만들어 @register 하면 된다 — 이 파일은 열지 않는다.

계약:
    policy = registry.resolve(TURN_KIND, name)(settings)

    policy.accepts_audio(state)     -> bool        입력 프레임을 VAD 에 넣을 것인가
    policy.on_speech_start(state)   -> str | None  발화가 감지됐을 때 취할 조치

`on_speech_start` 가 돌려주는 조치 이름은 스트림 핸들러가 해석한다.
지금 해석되는 것은 `stop_output` 하나다 — 클라이언트에 재생 중단을 알린다.
None 이면 아무것도 하지 않는다.

`settings` 는 defaults.yaml 의 `turn:` 섹션 전체다. 정책마다 필요한 값을 거기서
직접 읽으므로, 새 정책을 추가할 때 이 계약을 바꿀 필요가 없다.
"""

from __future__ import annotations

from dataclasses import dataclass

from ...registry import register

TURN_KIND = "turn"

# 스트림 핸들러가 해석하는 조치 이름
STOP_OUTPUT = "stop_output"


@dataclass
class TurnState:
    """
    지금 세션이 어떤 상태인가.

    delivering  번역 음성이 클라이언트에서 재생되고 있다고 보는 구간.
                서버는 스피커를 볼 수 없으므로 보낸 오디오의 길이로 추정하고,
                클라이언트가 control/playback 으로 알려주면 그걸로 보정한다.
    processing  세그먼트가 파이프라인을 돌고 있다 (아직 소리는 나지 않는다).
    """

    delivering: bool = False
    processing: bool = False


@register(TURN_KIND, "half_duplex")
class HalfDuplex:
    """
    TTS 재생 중에는 입력을 무시한다. 헤드셋 없는 환경에서 가장 안전하다.

    처리 중(processing)에는 막지 않는다. 그때는 소리가 나지 않으므로 에코가 없고,
    다음 발화를 미리 받아두면 그만큼 빨라진다.
    """

    def __init__(self, settings: dict):
        self._settings = settings

    def accepts_audio(self, state: TurnState) -> bool:
        return not state.delivering

    def on_speech_start(self, state: TurnState) -> str | None:
        return None


@register(TURN_KIND, "full_duplex")
class FullDuplex:
    """
    아무것도 막지 않는다. 클라이언트에 AEC(에코 제거)가 있을 때만 쓸 것.

    브라우저의 echoCancellation 은 도움이 되지만 그것만 믿으면 안 된다 —
    스피커 볼륨이 크면 그대로 루프가 돈다.
    """

    def __init__(self, settings: dict):
        self._settings = settings

    def accepts_audio(self, state: TurnState) -> bool:
        return True

    def on_speech_start(self, state: TurnState) -> str | None:
        return None
