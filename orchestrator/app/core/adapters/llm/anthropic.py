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

# 모델 목록의 페이지 크기. 이것도 프로토콜 상수다(이 API 가 허용하는 최대값).
# 기본값은 20 이라 그대로 두면 목록이 잘린 채로 온다. 잘림을 줄이려고 최대로 두고,
# 그래도 남으면 has_more 로 이어 받는다 — 실측: 10개, has_more=false.
MODELS_PAGE_SIZE = 1000


@register(LLM_KIND, "anthropic")
class Anthropic(BaseLLM):
    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
        }

    async def models(self) -> list[str]:
        """
        `GET {base_url}/models` → `{"data":[{"id":...}], "has_more":…, "last_id":…}`.

        커서 페이지네이션이라 `has_more` 가 참인 동안 `after_id` 로 이어 받는다.
        실패를 빈 목록으로 삼키지 않는다 — 사유가 화면까지 가야 한다.
        """
        names: list[str] = []
        params: dict[str, str | int] = {"limit": MODELS_PAGE_SIZE}
        async with httpx.AsyncClient(timeout=self._models_timeout()) as c:
            while True:
                r = await c.get(
                    f"{self.base_url}/models", headers=self._headers(), params=params
                )
                await self._raise_for_status(r)
                body = r.json()
                page = body.get("data") or []
                names.extend(
                    m["id"] for m in page if isinstance(m, dict) and m.get("id")
                )
                if not body.get("has_more") or not body.get("last_id"):
                    break
                params["after_id"] = body["last_id"]
        return sorted(names)

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
        # 프로바이더 고유 옵션(providers.yaml 의 `options:`)을 그대로 얹는다.
        self.merge_options(payload)
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
