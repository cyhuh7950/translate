"""
입력 오디오 전처리 — STT 에 넣기 직전에 한 번 거치는 자리.

두 경로가 같은 오디오 문제를 겪는다.

    PTT(HTTP)   POST /v1/translate/audio 로 올라온 파일 (webm/mp3/wav/…)
    핸즈프리(WS) modules/translate/streaming.py 가 VAD 로 잘라낸 세그먼트 (이미 PCM)

문제는 같고 해법도 같아야 하므로 **필터 구현은 한 벌만 둔다**
(`app/core/adapters/audio_filter/`). 이 모듈은 그 한 벌을 두 경로에 물리는 얇은 층이다.
차이는 표현 형식뿐이라 진입점을 둘로 나눠 둔다.

    filter_pcm()      int16 PCM 을 이미 들고 있는 쪽(WS)
    filter_upload()   컨테이너 바이트를 들고 있는 쪽(HTTP) — ffmpeg 로 풀어서 넘긴다

무엇도 던지지 않는다
--------------------
디코딩 실패, 설정 누락, 어댑터 오류 — 무엇이 나든 **원본을 그대로 돌려준다.**
전처리는 개선 장치이지 필수 단계가 아니다. 여기서 예외가 올라가 번역이 통째로
실패하면 얻는 것보다 잃는 것이 크다. 대신 이유를 로그와 `gate_skipped` 지표에
남긴다 — metrics 이벤트에 그대로 실려 나가므로 조용히 묻히지 않는다.

게이트를 끄면(`audio_filter.enabled: false`) 이 모듈은 입력을 손대지 않고
그대로 돌려준다. 디코딩조차 하지 않으므로 예전과 완전히 동일하게 동작한다.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import numpy as np

from . import registry
from .adapters.audio_filter._base import AUDIO_FILTER_KIND, FilterResult
from .audio import pcm16_to_wav
from .config import Config

log = logging.getLogger("preprocess")


def _reason(exc: Exception) -> dict[str, Any]:
    return {"gate_skipped": f"{type(exc).__name__}: {exc}"}


def enabled(cfg: Config) -> bool:
    return bool(cfg.get("audio_filter.enabled"))


def _build(cfg: Config, sample_rate: int):
    settings = cfg.require_section("audio_filter")
    name = cfg.get("audio_filter.implementation")
    return registry.resolve(AUDIO_FILTER_KIND, name)(settings, sample_rate)


# ---- PCM 경로 (WS) ---------------------------------------------------------


def filter_pcm(cfg: Config, pcm: np.ndarray, sample_rate: int) -> tuple[np.ndarray, dict]:
    """
    int16 mono PCM 에 필터를 건다. (필터를 거친 PCM, 지표) 를 돌려준다.

    꺼져 있거나 필터가 손댈 것이 없다고 판단하면 입력 배열을 그대로 돌려준다.
    """
    if not enabled(cfg):
        return pcm, {}
    try:
        result: FilterResult = _build(cfg, sample_rate).apply(pcm)
    except Exception as exc:
        log.warning("Audio filter skipped: %s: %s", type(exc).__name__, exc)
        return pcm, _reason(exc)
    return (result.pcm if result.applied else pcm), result.metrics


# ---- 컨테이너 경로 (HTTP 업로드) --------------------------------------------


async def filter_upload(
    cfg: Config, data: bytes, filename: str, content_type: str
) -> tuple[bytes, str, str, dict]:
    """
    업로드된 오디오 파일에 필터를 건다. (바이트, 파일이름, MIME, 지표) 를 돌려준다.

    필터는 PCM 위에서 동작하므로 컨테이너를 한 번 풀어야 한다. 브라우저가 보내는
    것은 webm/opus 이고 CLI 는 wav·mp3 를 보내므로 포맷을 가리지 않는 디코더가
    필요하다 — 이미지에 이미 있는 ffmpeg 을 쓴다.

    필터가 실제로 손을 댄 경우에만 WAV 로 다시 감싸 돌려준다. 그러지 않으면
    "게이트를 켜기만 해도 STT 에 들어가는 바이트가 달라지는" 상태가 되어,
    인식 결과가 바뀌었을 때 게이트 때문인지 재인코딩 때문인지 가릴 수 없게 된다.
    """
    if not enabled(cfg):
        return data, filename, content_type, {}

    sample_rate = int(cfg.get("audio.stt_sample_rate"))
    channels = int(cfg.get("audio.stt_channels"))

    try:
        pcm = await decode_pcm16(cfg, data, sample_rate=sample_rate, channels=channels)
    except Exception as exc:
        log.warning(
            "Could not decode the uploaded audio, sending it through unchanged: %s: %s",
            type(exc).__name__,
            exc,
        )
        return data, filename, content_type, _reason(exc)

    try:
        result: FilterResult = _build(cfg, sample_rate).apply(pcm)
    except Exception as exc:
        log.warning("Audio filter skipped: %s: %s", type(exc).__name__, exc)
        return data, filename, content_type, _reason(exc)

    if not result.applied:
        return data, filename, content_type, result.metrics

    wav = pcm16_to_wav(result.pcm, sample_rate=sample_rate, channels=channels)
    return (
        wav,
        cfg.get("audio.pcm_filename"),
        cfg.get("audio.pcm_content_type"),
        result.metrics,
    )


async def decode_pcm16(
    cfg: Config, data: bytes, *, sample_rate: int, channels: int
) -> np.ndarray:
    """
    임의의 오디오 컨테이너를 int16 PCM 으로 푼다. 실패하면 예외를 던진다(호출자가 삼킨다).

    비동기 서브프로세스를 쓰는 이유는 이벤트 루프를 막지 않기 위해서다. 디코딩은
    보통 수십 ms 지만 긴 업로드에서는 그보다 길어지고, 그동안 다른 세션의 WS 프레임이
    처리되지 않으면 그쪽 VAD 판정이 밀린다.
    """
    binary = cfg.get("audio.decoder")
    timeout = float(cfg.get("audio.decoder_timeout_s"))

    # 파이프 입출력이라 임시 파일을 만들지 않는다.
    # -vn: 앨범 아트 같은 영상 스트림을 무시한다 (mp3 에 흔하다).
    argv = [
        binary, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0", "-vn",
        "-f", "s16le", "-acodec", "pcm_s16le",
        "-ac", str(channels), "-ar", str(sample_rate),
        "pipe:1",
    ]

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(data), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"{binary} did not finish within {timeout}s") from None

    if proc.returncode != 0:
        detail = err.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(
            f"{binary} exited with {proc.returncode}: {detail[-1] if detail else 'no output'}"
        )
    if not out:
        raise RuntimeError(f"{binary} produced no audio samples")

    if len(out) % 2:
        out = out[: len(out) - 1]
    return np.frombuffer(out, dtype="<i2")
