"""
화자 임베딩 어댑터: voice 저장소의 speaker 엔진 규격 (`POST /v1/speaker/*`).

STT·TTS 어댑터와 같은 결이다 — HTTP 호출과 응답 정규화만 하고, 판단은 하지 않는다.
어느 엔진을 이 어댑터로 부를지는 engines.yaml 의 `adapter:` 가 정한다.

엔진 규격
--------
    POST /v1/speaker/embed   multipart `file`      → 발화 하나의 임베딩
    POST /v1/speaker/enroll  multipart `files` N개 → 평균 임베딩 + 발화 간 최소 유사도

임베딩은 엔진에서 L2 정규화돼 나오므로 **내적이 곧 코사인 유사도다.**
비교(누구인가 판정)는 여기서 하지 않는다. 호출하는 쪽의 정책이 할 일이다.

★ 여기서 오가는 벡터는 목소리에서 뽑은 생체정보에 준하는 값이다. 로그에 찍지 않는다.
"""

from __future__ import annotations

from typing import Any, Sequence

import httpx

from ... import upstream
from ...errors import AppError
from ...registry import register

# 엔진 종류 이름. engines.yaml 의 `kind: speaker` 와 같은 값이어야 한다.
SPEAKER_KIND = "speaker"

# 업로드 파일 하나 = (파일이름, 바이트, MIME)
FileTuple = tuple[str, bytes, str]


class SpeakerEngineError(AppError, RuntimeError):
    """
    엔진이 거절했거나 닿지 않았다.

    RuntimeError 도 함께 상속하는 이유는 이 예외를 RuntimeError 로 잡는 곳이
    있었기 때문이다. 잡는 쪽을 한꺼번에 고치지 않고도 코드가 실리게 한다.
    """

    default_code = "engine.speaker_failed"
    default_status = 502


@register(SPEAKER_KIND, "voice_speaker")
class VoiceSpeaker:
    def __init__(self, http: dict, *, expose_upstream_errors: bool):
        self._http = http
        # 엔진이 돌려준 오류 본문을 클라이언트에 보여도 되는가.
        # 기본값은 코드가 아니라 diagnostics.expose_upstream_errors 에 있다.
        self._expose = bool(expose_upstream_errors)

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            float(self._http["read_timeout_s"]),
            connect=float(self._http["connect_timeout_s"]),
        )

    @staticmethod
    def _headers(api_key: str) -> dict:
        return {"Authorization": f"Bearer {api_key}"} if api_key else {}

    async def _post(self, url: str, api_key: str, files: list) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self._timeout()) as c:
                r = await c.post(url, headers=self._headers(api_key), files=files)
        except httpx.HTTPError as exc:
            raise SpeakerEngineError(
                "engine.speaker_unreachable", error=type(exc).__name__, reason=exc
            ) from exc
        if r.status_code >= 400:
            raise upstream.failure(
                SpeakerEngineError,
                "engine.speaker_failed",
                body=r.text[:300],
                expose=self._expose,
                status_code=r.status_code,
            )
        return r.json()

    async def embed(
        self,
        *,
        url: str,
        api_key: str,
        audio: bytes,
        filename: str,
        content_type: str,
    ) -> dict[str, Any]:
        """발화 하나 → 임베딩. 1초 미만 같은 부적합한 오디오는 엔진이 400 으로 거절한다."""
        body = await self._post(
            f"{url}/v1/speaker/embed", api_key, [("file", (filename, audio, content_type))]
        )
        return {
            "embedding": body.get("embedding") or [],
            "dim": body.get("dim"),
            "duration": body.get("duration"),
            "model": body.get("model"),
            "engine_processing_s": body.get("processing_s"),
        }

    async def enroll(
        self,
        *,
        url: str,
        api_key: str,
        files: Sequence[FileTuple],
    ) -> dict[str, Any]:
        """
        발화 여러 개 → 평균 임베딩 (등록용).

        `min_pairwise_similarity` 는 올린 발화들이 서로 얼마나 닮았는지다.
        하나가 다른 사람 목소리면 이 값이 눈에 띄게 낮아지므로 등록 실수를 잡아낸다.
        """
        payload = [("files", (name, data, ctype)) for name, data, ctype in files]
        body = await self._post(f"{url}/v1/speaker/enroll", api_key, payload)
        return {
            "embedding": body.get("embedding") or [],
            "dim": body.get("dim"),
            "count": body.get("count"),
            "duration": body.get("duration"),
            "min_pairwise_similarity": body.get("min_pairwise_similarity"),
            "model": body.get("model"),
            "engine_processing_s": body.get("processing_s"),
        }
