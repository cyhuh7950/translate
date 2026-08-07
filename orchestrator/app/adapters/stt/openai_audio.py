"""
STT 어댑터: OpenAI Audio API 규격 (`POST /v1/audio/transcriptions`).

voice 저장소의 엔진들이 모두 이 규격을 쓰므로 whisper·moonshine·앞으로 붙일 GPU 엔진까지
이 파일 하나로 덮인다. 규격이 다른 엔진이 생기면 이 폴더에 파일을 하나 더 넣는다.

어느 엔진을 이 어댑터로 부를지는 engines.yaml 의 `adapter:` 가 정한다.
"""

from __future__ import annotations

from typing import Any

import httpx

from ...registry import register

STT_KIND = "stt"


@register(STT_KIND, "openai_audio")
class OpenAIAudioSTT:
    def __init__(self, http: dict):
        self._http = http

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            float(self._http["read_timeout_s"]),
            connect=float(self._http["connect_timeout_s"]),
        )

    async def transcribe(
        self,
        *,
        url: str,
        api_key: str,
        audio: bytes,
        filename: str,
        content_type: str,
        language: str | None,
    ) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        files = {"file": (filename, audio, content_type)}
        # 엔진이 언어를 자동 감지하도록 비워둘 수 있다. 지정하면 그 언어로 강제한다.
        data = {"response_format": "json"}
        if language:
            data["language"] = language

        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            r = await c.post(
                f"{url}/v1/audio/transcriptions", headers=headers, files=files, data=data
            )
            if r.status_code >= 400:
                raise RuntimeError(f"STT error {r.status_code}: {r.text[:300]}")
            body = r.json()

        return {
            "text": (body.get("text") or "").strip(),
            # 엔진이 감지한 언어. 요청에서 지정하지 않았을 때 방향 결정에 쓸 수 있다.
            "language": body.get("language"),
            "duration": body.get("duration"),
            "engine_processing_s": body.get("processing_s"),
        }
