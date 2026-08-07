"""
Anthropic Messages API 어댑터.

OpenAI 호환과 다른 점만 처리한다.
  - 인증 헤더가 x-api-key 이고 anthropic-version 이 필요하다
  - system 을 messages 안에 넣지 않고 최상위 필드로 분리한다
  - 스트리밍 이벤트 형식이 다르다 (content_block_delta)
  - max_tokens 가 필수다
"""

from __future__ import annotations

from typing import AsyncIterator

import httpx

from ...registry import register
from ._base import BaseLLM

LLM_KIND = "llm"

# API 버전은 프로토콜 상수라 설정이 아니라 여기 둔다. 바뀌면 이 파일을 고치는 게 맞다.
ANTHROPIC_VERSION = "2023-06-01"


@register(LLM_KIND, "anthropic")
class Anthropic(BaseLLM):
    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
        }

    async def models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            r = await c.get(f"{self.base_url}/models", headers=self._headers())
            if r.status_code >= 400:
                return []
            data = r.json().get("data", [])
        return sorted(m["id"] for m in data if isinstance(m, dict) and m.get("id"))

    async def chat(
        self,
        *,
        model: str | None,
        system: str,
        messages: list[dict[str, str]],
        stream: bool,
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.resolve_model(model),
            "system": system,
            "messages": messages,
            "temperature": float(self.settings.get("temperature")),
            "max_tokens": int(self.settings.get("max_output_tokens")),
            "stream": stream,
        }
        url = f"{self.base_url}/messages"

        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            if not stream:
                r = await c.post(url, headers=self._headers(), json=payload)
                await self._raise_for_status(r)
                blocks = r.json().get("content") or []
                yield "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
                return

            async with c.stream("POST", url, headers=self._headers(), json=payload) as r:
                if r.status_code >= 400:
                    await r.aread()
                    await self._raise_for_status(r)
                async for event in self._iter_sse(r):
                    if event.get("type") != "content_block_delta":
                        continue
                    delta = event.get("delta") or {}
                    piece = delta.get("text")
                    if piece:
                        yield piece
