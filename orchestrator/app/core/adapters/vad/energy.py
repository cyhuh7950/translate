"""
VAD 백엔드: energy — 프레임 RMS 에너지 임계값.

**의존성이 numpy 하나뿐이다.** 이게 이 구현을 기본값으로 둔 이유다.
silero 는 torch 를, webrtcvad 는 C 확장을 끌어온다. 개발 서버가 aarch64 4코어를
운영 서비스와 나눠 쓰는 상황에서 torch 를 얹으면 VAD 가 아니라 VAD 를 돌리는 일이
병목이 된다. 더 좋은 판정이 필요해지면 이 폴더에 `silero.py` 를 넣고
`vad.backend: silero` 로 바꾸면 된다 — 이 파일은 열지 않는다.

한계 (알고 쓰라고 적어둔다)
--------------------------
- **소리의 크기만 본다.** 사람 목소리인지 아닌지 구분하지 못한다. 키보드 소리,
  문 닫는 소리, 에어컨 바람이 임계값을 넘으면 발화로 잡힌다. `min_speech_ms` 가
  짧은 잡음은 걸러주지만 긴 소음은 못 막는다.
- **작게 말하면 놓친다.** 마이크 게인·거리·주변 소음에 따라 적정 임계값이 달라진다.
  그래서 고정 임계값만 쓰지 않고 무음 구간의 잡음 바닥을 추적해 상대 임계값을
  함께 본다(`adaptive`). 그래도 화자가 아주 조용하면 한계가 있다.
- **어미가 잘릴 수 있다.** 한국어 종결어미는 끝이 약해져 에너지가 먼저 떨어진다.
  `post_roll_ms` 로 꼬리를 남기고 `silence_ms` 를 너무 짧게 잡지 않는 것으로 완화한다.
- 음악·TV 처럼 계속 소리가 나는 환경에서는 `max_speech_ms` 로 끊기 전까지 계속
  한 발화로 본다.

판정 흐름
---------
프레임마다 RMS 를 재고, 유성 프레임이 `start_frames` 만큼 연속되면 발화 시작,
무음이 `silence_ms` 만큼 연속되면 발화 끝. 시작 시점 앞의 `pre_roll_ms` 를
붙여 첫 음절이 잘리지 않게 하고, 끝에서는 `post_roll_ms` 만 남기고 무음을 버린다.
**이 꼬리 자르기가 인식 시간을 줄이는 실질적인 부분이다** — STT 는 무음도 같은
속도로 처리하므로, 보내지 않은 무음만큼 그대로 시간이 준다.
"""

from __future__ import annotations

import logging
from collections import deque

import numpy as np

from ...registry import register
from ._base import SPEECH_END, SPEECH_START, VAD_KIND, VadError, VadEvent, need

log = logging.getLogger("vad.energy")

# int16 을 -1.0~1.0 으로 정규화할 때 쓰는 값. 포맷의 성질이라 설정이 아니다.
_INT16_FULL_SCALE = 32768.0


@register(VAD_KIND, "energy")
class EnergyVad:
    def __init__(self, settings: dict, sample_rate: int):
        if sample_rate <= 0:
            raise VadError("vad.sample_rate_invalid", sample_rate=sample_rate)
        self._sr = int(sample_rate)

        g = lambda key: need(settings, key, "energy")  # noqa: E731

        self._frame_ms = int(g("frame_ms"))
        if self._frame_ms <= 0:
            raise VadError("vad.frame_ms_invalid")
        self._frame = max(1, round(self._sr * self._frame_ms / 1000))
        # 반올림된 프레임 크기로 실제 프레임 길이를 다시 계산한다.
        # 그러지 않으면 at_ms 가 조금씩 어긋난다.
        self._ms_per_frame = self._frame * 1000.0 / self._sr

        self._threshold = float(g("threshold"))
        self._adaptive = bool(g("adaptive"))
        self._noise_margin_db = float(g("noise_margin_db"))
        self._noise_decay = float(g("noise_decay"))

        self._start_frames = max(1, self._frames_for(int(g("start_ms"))))
        self._silence_frames = max(1, self._frames_for(int(g("silence_ms"))))
        self._min_speech_frames = max(1, self._frames_for(int(g("min_speech_ms"))))
        self._pre_frames = max(0, self._frames_for(int(g("pre_roll_ms"))))
        self._post_frames = max(0, self._frames_for(int(g("post_roll_ms"))))
        max_speech_ms = int(g("max_speech_ms"))
        # 0 이면 강제 확정을 하지 않는다는 뜻이다.
        self._max_frames = self._frames_for(max_speech_ms) if max_speech_ms > 0 else 0

        # 잡음 바닥의 초기 추정치. 실제 무음이 들어오면 곧 갱신된다.
        self._noise = self._threshold
        self._noise_ratio = 10.0 ** (self._noise_margin_db / 20.0)

        self._tail = np.empty(0, dtype=np.int16)     # 프레임을 못 채운 나머지
        self._pre: deque[np.ndarray] = deque(maxlen=self._pre_frames or 1)
        self._segment: list[np.ndarray] = []
        self._in_speech = False
        self._voiced_run = 0
        self._silence_run = 0
        self._voiced_frames = 0
        self._pos_frames = 0                         # 스트림 시작부터 소비한 프레임 수
        self._start_frame = 0                        # 현재 발화가 시작된 프레임 위치

    # ---- 도구 -------------------------------------------------------------

    def _frames_for(self, ms: int) -> int:
        return int(round(ms / self._ms_per_frame))

    def _ms(self, frames: int) -> int:
        return int(round(frames * self._ms_per_frame))

    # ---- 계약 -------------------------------------------------------------

    @property
    def frame_ms(self) -> int:
        """클라이언트에 권장 프레임 길이를 알려줄 때 쓴다."""
        return self._frame_ms

    def push(self, pcm: np.ndarray) -> list[VadEvent]:
        """길이 제한 없는 int16 mono 배열을 넣는다. 발생한 이벤트를 순서대로 돌려준다."""
        if pcm.dtype != np.int16:
            pcm = pcm.astype(np.int16, copy=False)
        if pcm.ndim != 1:
            pcm = pcm.reshape(-1)

        if self._tail.size:
            pcm = np.concatenate((self._tail, pcm))
        count = pcm.size // self._frame
        self._tail = pcm[count * self._frame:].copy()

        events: list[VadEvent] = []
        for i in range(count):
            frame = pcm[i * self._frame:(i + 1) * self._frame]
            events.extend(self._consume(frame))
        return events

    def flush(self) -> list[VadEvent]:
        """스트림 종료. 진행 중인 발화를 그 자리에서 확정한다."""
        events: list[VadEvent] = []
        # 프레임을 못 채운 나머지는 발화 중일 때만 의미가 있다.
        if self._in_speech and self._tail.size:
            self._segment.append(self._tail.copy())
        self._tail = np.empty(0, dtype=np.int16)
        if self._in_speech:
            events.append(self._finish("flush"))
        return events

    # ---- 판정 -------------------------------------------------------------

    def _consume(self, frame: np.ndarray) -> list[VadEvent]:
        self._pos_frames += 1
        voiced = self._is_voiced(frame)
        events: list[VadEvent] = []

        if not self._in_speech:
            if self._pre_frames:
                self._pre.append(frame.copy())
            self._voiced_run = self._voiced_run + 1 if voiced else 0
            if self._voiced_run >= self._start_frames:
                # pre-roll 에는 방금 유성으로 센 프레임들도 들어 있다.
                self._segment = list(self._pre)
                self._pre.clear()
                self._in_speech = True
                self._silence_run = 0
                self._voiced_frames = self._voiced_run
                self._voiced_run = 0
                self._start_frame = self._pos_frames - len(self._segment)
                events.append(
                    VadEvent(state=SPEECH_START, at_ms=self._ms(max(0, self._start_frame)))
                )
            return events

        self._segment.append(frame.copy())
        if voiced:
            self._voiced_frames += 1
            self._silence_run = 0
        else:
            self._silence_run += 1

        if self._silence_run >= self._silence_frames:
            events.append(self._finish("silence"))
        elif self._max_frames and len(self._segment) >= self._max_frames:
            # 계속 소리가 나는 환경에서 무한히 길어지지 않게 잘라준다.
            events.append(self._finish("max_speech"))
        return events

    def _is_voiced(self, frame: np.ndarray) -> bool:
        signal = frame.astype(np.float32) / _INT16_FULL_SCALE
        rms = float(np.sqrt(np.mean(signal * signal))) if signal.size else 0.0

        threshold = self._threshold
        if self._adaptive:
            threshold = max(threshold, self._noise * self._noise_ratio)

        voiced = rms >= threshold
        if self._adaptive and not voiced:
            # 무음일 때만 잡음 바닥을 갱신한다. 발화 중에 올리면 자기 목소리에
            # 바닥이 끌려 올라가 뒷부분을 무음으로 오판한다.
            self._noise = (
                self._noise_decay * self._noise + (1.0 - self._noise_decay) * rms
            )
        return voiced

    def _finish(self, reason: str) -> VadEvent:
        segment = self._segment
        self._segment = []
        self._in_speech = False
        self._pre.clear()

        end_frame = self._pos_frames
        speech_ms = self._ms(self._voiced_frames)
        dropped = self._voiced_frames < self._min_speech_frames

        if dropped:
            log.debug(
                "Dropping segment: %d ms of speech is under min_speech_ms", speech_ms
            )
            self._voiced_frames = 0
            self._silence_run = 0
            return VadEvent(
                state=SPEECH_END,
                at_ms=self._ms(end_frame),
                speech_ms=speech_ms,
                dropped=True,
                reason=reason,
            )

        # 꼬리 무음을 post_roll 만 남기고 버린다. 여기서 인식 시간이 준다.
        keep = len(segment) - max(0, self._silence_run - self._post_frames)
        keep = max(1, min(len(segment), keep))
        audio = np.concatenate(segment[:keep]) if keep else np.empty(0, dtype=np.int16)

        self._voiced_frames = 0
        self._silence_run = 0
        return VadEvent(
            state=SPEECH_END,
            at_ms=self._ms(end_frame),
            audio=audio,
            duration_ms=int(round(audio.size * 1000 / self._sr)),
            speech_ms=speech_ms,
            dropped=False,
            reason=reason,
        )
