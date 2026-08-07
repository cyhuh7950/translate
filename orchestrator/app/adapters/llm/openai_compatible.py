"""
OpenAI 호환 프로바이더 — Cerebras, Groq, Mistral, OpenRouter, Upstage, OpenAI, Ollama.

이 파일 하나가 7개 프로바이더를 덮는다. 차이는 base_url 과 모델 이름뿐이고 둘 다 설정이다.
새 OpenAI 호환 프로바이더가 생기면 providers.yaml 에 항목 하나 추가로 끝난다 — 코드 수정 없음.
"""

from __future__ import annotations

from typing import AsyncIterator

import httpx

from ...registry import register
from ._base import BaseLLM

LLM_KIND = "llm"


@register(LLM_KIND, "openai_compatible")
class OpenAICompatible(BaseLLM):
    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    async def models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            r = await c.get(f"{self.base_url}/models", headers=self._headers())
            await self._raise_for_status(r)
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
            "messages": [{"role": "system", "content": system}, *messages],
            "temperature": float(self.settings.get("temperature")),
            "max_tokens": int(self.settings.get("max_output_tokens")),
            "stream": stream,
        }
        url = f"{self.base_url}/chat/completions"

        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            if not stream:
                r = await c.post(url, headers=self._headers(), json=payload)
                await self._raise_for_status(r)
                choices = r.json().get("choices") or []
                yield (choices[0]["message"]["content"] if choices else "") or ""
                return

            async with c.stream("POST", url, headers=self._headers(), json=payload) as r:
                if r.status_code >= 400:
                    await r.aread()
                    await self._raise_for_status(r)
                async for chunk in self._iter_sse(r):
                    for ch in chunk.get("choices") or []:
                        piece = (ch.get("delta") or {}).get("content")
                        if piece:
                            yield piece
