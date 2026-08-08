"""
TTS 어댑터: OpenAI Audio API 규격 (`POST /v1/audio/speech`).

voice 저장소의 supertonic·melotts 가 이 규격을 쓴다. 응답은 오디오 바이트이고
샘플레이트·길이·처리시간은 X- 헤더로 온다.
"""

from __future__ import annotations

from typing import Any

import httpx

from ...registry import register

TTS_KIND = "tts"


@register(TTS_KIND, "openai_audio")
class OpenAIAudioTTS:
    def __init__(self, http: dict):
        self._http = http

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            float(self._http["read_timeout_s"]),
            connect=float(self._http["connect_timeout_s"]),
        )

    async def synthesize(
        self,
        *,
        url: str,
        api_key: str,
        text: str,
        voice: str | None,
        language: str | None,
        speed: float,
        response_format: str,
    ) -> dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        payload: dict[str, Any] = {
            "input": text,
            "speed": speed,
            "response_format": response_format,
        }
        # 비워두면 엔진의 기본 보이스·언어를 쓴다. 엔진마다 목록이 다르므로 강제하지 않는다.
        if voice:
            payload["voice"] = voice
        if language:
            payload["language"] = language

        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            r = await c.post(f"{url}/v1/audio/speech", headers=headers, json=payload)
            if r.status_code >= 400:
                raise RuntimeError(f"TTS error {r.status_code}: {r.text[:300]}")
            audio = r.content
            meta = r.headers

        return {
            "audio": audio,
            "content_type": meta.get("content-type", "application/octet-stream"),
            "sample_rate": _to_int(meta.get("x-sample-rate")),
            "duration": _to_float(meta.get("x-audio-duration")),
            "engine_processing_s": _to_float(meta.get("x-processing-seconds")),
        }


def _to_int(v: str | None) -> int | None:
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


def _to_float(v: str | None) -> float | None:
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None
