"""
오디오 컨테이너 도구.

WS 로 들어오는 것은 헤더 없는 PCM16 이고, STT 엔진은 파일을 받는다.
세그먼트가 확정되면 여기서 WAV 컨테이너를 씌워 기존 배치 파이프라인에 그대로 넘긴다.
파이프라인을 복제하지 않기 위한 얇은 층이다.
"""

from __future__ import annotations

import io
import wave

import numpy as np

# WAV 는 int16 PCM 을 2바이트로 담는다. 포맷의 성질이라 설정값이 아니다.
_BYTES_PER_SAMPLE = 2


def pcm16_to_wav(pcm: np.ndarray | bytes, *, sample_rate: int, channels: int) -> bytes:
    """int16 PCM 을 WAV 로 감싼다. 샘플 값은 건드리지 않는다."""
    if isinstance(pcm, np.ndarray):
        raw = pcm.astype(np.int16, copy=False).tobytes()
    else:
        raw = bytes(pcm)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(int(channels))
        w.setsampwidth(_BYTES_PER_SAMPLE)
        w.setframerate(int(sample_rate))
        w.writeframes(raw)
    return buf.getvalue()


def pcm16_from_bytes(data: bytes) -> np.ndarray:
    """WS 바이너리 프레임을 int16 배열로. 홀수 바이트는 잘라 버린다."""
    if len(data) % _BYTES_PER_SAMPLE:
        data = data[: len(data) - (len(data) % _BYTES_PER_SAMPLE)]
    return np.frombuffer(data, dtype="<i2")


def duration_s(samples: int, sample_rate: int) -> float:
    return samples / float(sample_rate) if sample_rate else 0.0
