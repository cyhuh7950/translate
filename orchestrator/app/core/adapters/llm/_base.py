"""
LLM 어댑터 공통부.

밑줄로 시작하므로 registry.discover() 가 이 파일을 직접 import 하지 않는다. 다른 어댑터가 쓴다.

어댑터가 담당하는 것은 **프로토콜 차이뿐**이다. 번역 프롬프트를 만들고 맥락을 붙이는 일은
translator.py 가 하고, 어댑터는 "메시지를 보내고 토큰을 받아온다"만 구현한다.
그래서 새 프로바이더가 OpenAI 호환이면 providers.yaml 에 항목 하나 추가로 끝난다.

계약:
    models()  -> list[str]                 사용 가능한 모델 목록 (없으면 빈 리스트)
    chat(...) -> AsyncIterator[str]        토큰 델타를 순서대로. stream=False 면 한 번에 하나.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, AsyncIterator

import httpx

from ... import upstream
from ...errors import AppError

log = logging.getLogger("llm")


class LLMError(AppError):
    """프로바이더를 고르지 못했거나 프로바이더가 실패했다."""

    default_code = "llm.provider_failed"
    default_status = 502


class BaseLLM:
    """프로바이더 하나에 대응한다. providers.yaml 의 항목이 그대로 spec 으로 들어온다."""

    def __init__(
        self,
        provider_id: str,
        spec: dict,
        settings: dict,
        *,
        expose_upstream_errors: bool,
    ):
        self.id = provider_id
        self.spec = spec
        self.settings = settings          # llm.* 설정 (temperature, timeout 등)
        # 프로바이더가 돌려준 오류 본문을 클라이언트에 보여도 되는가.
        # 기본값은 코드가 아니라 diagnostics.expose_upstream_errors 에 있다.
        self._expose = bool(expose_upstream_errors)
        self.base_url = (spec.get("base_url") or "").rstrip("/")
        if not self.base_url:
            raise LLMError("llm.no_base_url", provider=provider_id)

    # ---- 공통 도우미 -------------------------------------------------------

    @property
    def api_key(self) -> str:
        """키는 설정 파일이 아니라 환경변수(secrets.env)에서 온다."""
        return os.environ.get(self.spec.get("api_key_env", ""), "").strip()

    def resolve_model(self, requested: str | None) -> str:
        model = (requested or self.spec.get("default_model") or "").strip()
        if not model:
            raise LLMError("llm.no_model", status=400, provider=self.id)
        return model

    def _timeout(self) -> httpx.Timeout:
        total = float(self.settings.get("request_timeout_s"))
        return httpx.Timeout(total, connect=min(10.0, total))

    async def _raise_for_status(self, r: httpx.Response) -> None:
        if r.status_code < 400:
            return
        # 본문은 언제나 로그로 가고, 클라이언트에 보일지는 설정이 정한다.
        # 프로바이더 오류 본문에는 조직 식별자·요금제·레이트리밋 한도가 섞여 있다.
        raise upstream.failure(
            LLMError,
            "llm.provider_failed",
            body=r.text[:400] if r.content else "",
            expose=self._expose,
            provider=self.id,
            status_code=r.status_code,
        )

    @staticmethod
    async def _iter_sse(r: httpx.Response) -> AsyncIterator[dict]:
        """text/event-stream 의 data: 줄을 JSON 으로. [DONE] 은 끝 신호."""
        async for raw in r.aiter_lines():
            line = raw.strip()
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                return
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                continue

    # ---- 하위 클래스가 구현 -------------------------------------------------

    async def models(self) -> list[str]:
        return []

    async def chat(
        self,
        *,
        model: str | None,
        system: str,
        messages: list[dict[str, str]],
        stream: bool,
    ) -> AsyncIterator[str]:
        raise NotImplementedError
