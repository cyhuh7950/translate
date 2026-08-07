"""
Google Gemini 어댑터.

OpenAI 호환과 다른 점만 처리한다.
  - 모델 이름이 경로에 들어간다 (/models/{model}:generateContent)
  - 키를 쿼리 파라미터로 넘긴다
  - 역할 이름이 assistant 가 아니라 model 이고, 내용이 parts 배열이다
  - system 은 systemInstruction 으로 분리한다
"""

from __future__ import annotations

from typing import AsyncIterator

import httpx

from ...registry import register
from ._base import BaseLLM

LLM_KIND = "llm"


@register(LLM_KIND, "gemini")
class Gemini(BaseLLM):
    def _params(self) -> dict[str, str]:
        return {"key": self.api_key}

    async def models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            r = await c.get(f"{self.base_url}/models", params=self._params())
            if r.status_code >= 400:
                return []
            data = r.json().get("models", [])
        # "models/gemini-..." 형태로 오므로 접두사를 떼고 돌려준다
        return sorted(
            m["name"].split("/", 1)[-1]
            for m in data
            if isinstance(m, dict) and m.get("name")
        )

    @staticmethod
    def _to_contents(messages: list[dict[str, str]]) -> list[dict]:
        out = []
        for m in messages:
            role = "model" if m.get("role") == "assistant" else "user"
            out.append({"role": role, "parts": [{"text": m.get("content", "")}]})
        return out

    @staticmethod
    def _extract(chunk: dict) -> str:
        pieces = []
        for cand in chunk.get("candidates") or []:
            for part in (cand.get("content") or {}).get("parts") or []:
                if part.get("text"):
                    pieces.append(part["text"])
        return "".join(pieces)

    async def chat(
        self,
        *,
        model: str | None,
        system: str,
        messages: list[dict[str, str]],
        stream: bool,
    ) -> AsyncIterator[str]:
        name = self.resolve_model(model)
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": self._to_contents(messages),
            "generationConfig": {
                "temperature": float(self.settings.get("temperature")),
                "maxOutputTokens": int(self.settings.get("max_output_tokens")),
            },
        }

        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            if not stream:
                url = f"{self.base_url}/models/{name}:generateContent"
                r = await c.post(url, params=self._params(), json=payload)
                await self._raise_for_status(r)
                yield self._extract(r.json())
                return

            url = f"{self.base_url}/models/{name}:streamGenerateContent"
            params = {**self._params(), "alt": "sse"}
            async with c.stream("POST", url, params=params, json=payload) as r:
                if r.status_code >= 400:
                    await r.aread()
                    await self._raise_for_status(r)
                async for chunk in self._iter_sse(r):
                    piece = self._extract(chunk)
                    if piece:
                        yield piece
