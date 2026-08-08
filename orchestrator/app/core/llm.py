"""
LLM 프로바이더 레지스트리와 번역기.

어댑터는 프로토콜 차이만 담당하고, "무엇을 어떻게 물어볼지"는 여기서 만든다.
프롬프트·스타일·맥락 턴 수는 전부 설정(prompts.*, llm.*)에서 온다.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import AsyncIterator

from . import registry
from .adapters.llm._base import BaseLLM, LLMError
from .config import Config

log = logging.getLogger("llm")

LLM_KIND = "llm"


@dataclass
class Turn:
    """대화 맥락 한 턴. 한국어는 주어 생략이 많아 맥락 없이는 대명사를 틀린다."""
    source: str
    target: str


class ProviderRegistry:
    """providers.yaml 을 읽어 어댑터 인스턴스를 만든다."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._cache: dict[str, BaseLLM] = {}

    def invalidate(self) -> None:
        self._cache.clear()

    def _spec(self, provider_id: str) -> dict:
        providers = self._cfg.require_section("providers")
        if provider_id not in providers:
            raise LLMError(
                f"Unknown provider: '{provider_id}'. "
                f"Available: {', '.join(providers) or '(none)'}"
            )
        return providers[provider_id]

    def get(self, provider_id: str | None) -> BaseLLM:
        pid = (provider_id or self._cfg.get("llm.default_provider") or "").strip()
        if not pid:
            raise LLMError(
                "No LLM provider specified. "
                "Pass provider in the request or set llm.default_provider in defaults.yaml"
            )
        if pid in self._cache:
            return self._cache[pid]

        spec = self._spec(pid)
        kind = spec.get("kind", "")
        adapter_cls = registry.resolve(LLM_KIND, kind)   # 분기문 없이 이름으로
        instance = adapter_cls(pid, spec, self._cfg.require_section("llm"))
        self._cache[pid] = instance
        return instance

    def unavailable_reason(self, provider_id: str) -> str | None:
        spec = self._spec(provider_id)
        kind = spec.get("kind", "")
        if not registry.has(LLM_KIND, kind):
            return (
                f"Adapter kind '{kind}' is not registered "
                f"(available: {', '.join(registry.available(LLM_KIND)) or 'none'})"
            )
        if spec.get("requires_key", True):
            if not os.environ.get(spec.get("api_key_env", ""), "").strip():
                return f"API key is missing ({spec.get('api_key_env')})"
        return None

    def public_view(self) -> list[dict]:
        """키 값은 절대 내보내지 않는다. 사용 가능 여부와 이유만."""
        out = []
        for pid, spec in self._cfg.require_section("providers").items():
            reason = self.unavailable_reason(pid)
            out.append({
                "id": pid,
                "label": spec.get("label", pid),
                "kind": spec.get("kind"),
                "default_model": spec.get("default_model") or None,
                # 첫 토큰이 빠른 프로바이더. 실시간 모드에서 유리하다.
                "fast": bool(spec.get("fast", False)),
                "available": reason is None,
                "reason": reason,
            })
        return out

    async def models(self, provider_id: str) -> list[str]:
        return await self.get(provider_id).models()


class Translator:
    """프롬프트를 만들고 어댑터를 호출한다. 번역 방향은 호출자가 정해서 넘긴다."""

    def __init__(self, cfg: Config, providers: ProviderRegistry):
        self._cfg = cfg
        self._providers = providers

    def _system_prompt(self, *, source_lang: str, target_lang: str, style: str | None) -> str:
        style_name = style or self._cfg.get("llm.style")
        styles = self._cfg.require_section("prompts.styles")
        if style_name not in styles:
            raise LLMError(
                f"Unknown translation style: '{style_name}' (available: {', '.join(styles)})"
            )
        return self._cfg.get("prompts.system").format(
            source_lang=source_lang,
            target_lang=target_lang,
            style=styles[style_name],
        )

    def _messages(
        self, text: str, context: list[Turn] | None, glossary: dict[str, str] | None
    ) -> list[dict[str, str]]:
        msgs: list[dict[str, str]] = []

        if glossary:
            terms = "\n".join(f"- {k} → {v}" for k, v in glossary.items())
            msgs.append({
                "role": "user",
                "content": f"Glossary (use these translations consistently):\n{terms}",
            })
            msgs.append({"role": "assistant", "content": "Understood."})

        limit = int(self._cfg.get("llm.context_turns"))
        for turn in (context or [])[-limit:] if limit > 0 else []:
            msgs.append({"role": "user", "content": turn.source})
            msgs.append({"role": "assistant", "content": turn.target})

        msgs.append({"role": "user", "content": text})
        return msgs

    async def stream(
        self,
        text: str,
        *,
        source_lang: str,
        target_lang: str,
        provider: str | None = None,
        model: str | None = None,
        style: str | None = None,
        context: list[Turn] | None = None,
        glossary: dict[str, str] | None = None,
    ) -> AsyncIterator[str]:
        adapter = self._providers.get(provider)
        system = self._system_prompt(
            source_lang=source_lang, target_lang=target_lang, style=style
        )
        async for piece in adapter.chat(
            model=model,
            system=system,
            messages=self._messages(text, context, glossary),
            stream=True,
        ):
            yield piece

    async def translate(
        self,
        text: str,
        *,
        source_lang: str,
        target_lang: str,
        provider: str | None = None,
        model: str | None = None,
        style: str | None = None,
        context: list[Turn] | None = None,
        glossary: dict[str, str] | None = None,
    ) -> str:
        adapter = self._providers.get(provider)
        system = self._system_prompt(
            source_lang=source_lang, target_lang=target_lang, style=style
        )
        chunks = []
        async for piece in adapter.chat(
            model=model,
            system=system,
            messages=self._messages(text, context, glossary),
            stream=False,
        ):
            chunks.append(piece)
        return "".join(chunks).strip()
