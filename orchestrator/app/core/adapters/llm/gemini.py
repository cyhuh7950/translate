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

# 번역에 쓰는 메서드 이름. 프로토콜 상수라 여기 둔다 — 아래 두 곳(목록 걸러내기와
# 호출 경로)이 같은 값을 써야 한다.
GENERATE_METHOD = "generateContent"

# 목록 페이지 크기. 이 API 가 허용하는 최대값이고 기본값(50)으로 두면 잘려서 온다.
# 남으면 nextPageToken 으로 이어 받는다.
MODELS_PAGE_SIZE = 1000

# 모델이 지원하는 메서드가 실려 오는 필드. 규격이 두 이름을 써 와서 둘 다 본다.
# 둘 다 없으면 걸러내지 않는다 — 모를 때 감추는 것보다 보여주는 쪽이 낫다.
METHOD_FIELDS = ("supportedGenerationMethods", "supportedActions")


@register(LLM_KIND, "gemini")
class Gemini(BaseLLM):
    def _params(self) -> dict[str, str]:
        return {"key": self.api_key}

    @staticmethod
    def _can_generate(model: dict) -> bool:
        """번역에 쓸 수 있는 모델인가. 임베딩·이미지 전용 모델을 목록에서 뺀다."""
        for field in METHOD_FIELDS:
            methods = model.get(field)
            if isinstance(methods, list):
                return GENERATE_METHOD in methods
        return True

    async def models(self) -> list[str]:
        """
        `GET {base_url}/models` → `{"models":[{"name":"models/…"}], "nextPageToken":…}`.

        OpenAI 호환과 세 가지가 다르다. 키가 쿼리로 가고, 이름에 `models/` 접두사가
        붙어 있고, 토큰 페이지네이션이다. 그리고 이 목록에는 번역에 못 쓰는 모델
        (임베딩·이미지)도 섞여 있어 지원 메서드로 걸러낸다.
        """
        names: list[str] = []
        async with httpx.AsyncClient(timeout=self._models_timeout()) as c:
            params = {**self._params(), "pageSize": str(MODELS_PAGE_SIZE)}
            while True:
                r = await c.get(f"{self.base_url}/models", params=params)
                await self._raise_for_status(r)
                body = r.json()
                for m in body.get("models") or []:
                    if not isinstance(m, dict) or not m.get("name"):
                        continue
                    if not self._can_generate(m):
                        continue
                    # "models/gemini-..." 형태로 오므로 접두사를 뗀다
                    names.append(m["name"].split("/", 1)[-1])
                token = body.get("nextPageToken")
                if not token:
                    break
                params = {**params, "pageToken": token}
        return sorted(names)

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
        # 프로바이더 고유 옵션(providers.yaml 의 `options:`)을 그대로 얹는다.
        # `generationConfig` 를 적으면 위에서 만든 것과 한 겹 병합된다 (BaseLLM 주석).
        self.merge_options(payload)

        async with httpx.AsyncClient(timeout=self._timeout()) as c:
            if not stream:
                url = f"{self.base_url}/models/{name}:{GENERATE_METHOD}"
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
