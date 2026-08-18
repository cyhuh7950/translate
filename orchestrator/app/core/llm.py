"""
LLM 프로바이더 레지스트리와 번역기.

어댑터는 프로토콜 차이만 담당하고, "무엇을 어떻게 물어볼지"는 여기서 만든다.
프롬프트·스타일·맥락 턴 수는 전부 설정(prompts.*, llm.*)에서 온다.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import AsyncIterator

from . import registry
from .adapters.llm._base import BaseLLM, LLMError
from .config import Config
from .errors import AppError, listing

log = logging.getLogger("llm")

LLM_KIND = "llm"


@dataclass
class Turn:
    """대화 맥락 한 턴. 한국어는 주어 생략이 많아 맥락 없이는 대명사를 틀린다."""
    source: str
    target: str


@dataclass
class ModelListing:
    """
    한 프로바이더의 모델 목록 한 벌.

    **실패도 결과다.** 조회가 안 됐으면 빈 목록과 함께 사유(`error`)를 들고 온다 —
    조용히 빈 목록만 돌려주면 "모델이 없는 프로바이더"와 "조회가 실패한 프로바이더"가
    구별되지 않아 화면에 이유를 띄울 수 없다.
    """

    provider: str
    models: list[str] = field(default_factory=list)
    error: AppError | None = None
    # 캐시 판정용 시각. 벽시계가 아니라 단조시계다 (시각 보정에 흔들리지 않게).
    fetched_at: float = 0.0

    @property
    def ok(self) -> bool:
        return self.error is None


class ProviderRegistry:
    """providers.yaml 을 읽어 어댑터 인스턴스를 만든다."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._cache: dict[str, BaseLLM] = {}
        # 모델 목록 캐시와, 지금 조회 중인 것들. 후자가 있어야 동시 요청이 같은
        # 프로바이더를 여러 번 부르지 않는다 (설정 화면을 두 기기가 함께 열 때).
        self._models: dict[str, ModelListing] = {}
        self._inflight: dict[str, asyncio.Task] = {}

    def invalidate(self) -> None:
        self._cache.clear()
        # base_url·키·옵션이 바뀌었을 수 있으니 목록도 함께 버린다.
        self._models.clear()

    def _spec(self, provider_id: str) -> dict:
        providers = self._cfg.require_section("providers")
        if provider_id not in providers:
            raise LLMError(
                "llm.unknown_provider",
                status=400,
                provider=provider_id,
                available=listing(providers),
            )
        return providers[provider_id]

    def get(self, provider_id: str | None) -> BaseLLM:
        pid = (provider_id or self._cfg.get("llm.default_provider") or "").strip()
        if not pid:
            raise LLMError("llm.no_provider", status=400)
        if pid in self._cache:
            return self._cache[pid]

        spec = self._spec(pid)
        kind = spec.get("kind", "")
        adapter_cls = registry.resolve(LLM_KIND, kind)   # 분기문 없이 이름으로
        instance = adapter_cls(
            pid,
            spec,
            self._cfg.require_section("llm"),
            expose_upstream_errors=bool(self._cfg.get("diagnostics.expose_upstream_errors")),
        )
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

    # ---- 모델 목록 -----------------------------------------------------------
    #
    # 모델 이름을 설정에 박아두면 프로바이더가 목록을 바꿀 때마다 번역이 멈춘다.
    # 그래서 목록은 프로바이더에 직접 물어본다. 설계에서 지킨 것 셋.
    #
    #   1. `/v1/config` 를 느리게 만들지 않는다 — 목록은 거기 실리지 않는다.
    #      앱이 시작할 때마다 부르는 응답이라 9곳을 조회하면 시작이 그만큼 늦어진다.
    #   2. **한 프로바이더가 죽어도 다른 것이 막히지 않는다** — 동시에 조회하고,
    #      실패는 그 프로바이더의 결과 안에 사유로 담긴다.
    #   3. 결과는 캐시한다. TTL·타임아웃 전부 설정에서 온다.

    async def _fetch(self, provider_id: str) -> ModelListing:
        """
        한 프로바이더를 실제로 조회한다. **예외를 밖으로 내보내지 않는다** —
        실패는 사유가 담긴 결과로 바뀐다. 그래야 하나가 죽어도 나머지가 나간다.
        """
        # 키가 없거나 어댑터가 없는 프로바이더는 부르지 않는다. 부를 필요가 없고,
        # 부르면 401 을 기다리는 시간만 든다.
        reason = self.unavailable_reason(provider_id)
        if reason is not None:
            return ModelListing(
                provider_id,
                error=LLMError(
                    "llm.models_provider_unavailable",
                    status=400,
                    provider=provider_id,
                    reason=reason,
                ),
                fetched_at=time.monotonic(),
            )
        try:
            models = await self.get(provider_id).models()
            return ModelListing(provider_id, models, fetched_at=time.monotonic())
        except AppError as exc:
            # 어댑터가 사유를 이미 코드로 들고 있다 (llm.provider_failed 등).
            log.warning("Could not list models for '%s': %s", provider_id, exc)
            return ModelListing(provider_id, error=exc, fetched_at=time.monotonic())
        except Exception as exc:
            # 연결 실패·타임아웃·깨진 JSON. 여기서 코드를 붙여 화면까지 나른다.
            log.warning("Could not list models for '%s': %s", provider_id, exc)
            return ModelListing(
                provider_id,
                error=LLMError(
                    "llm.models_failed",
                    provider=provider_id,
                    reason=f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__,
                ),
                fetched_at=time.monotonic(),
            )

    def _fresh(self, provider_id: str) -> ModelListing | None:
        """캐시에 아직 쓸 수 있는 것이 있으면 그것. TTL 이 0 이면 캐시하지 않는다."""
        ttl = float(self._cfg.get("llm.models_cache_ttl_s"))
        if ttl <= 0:
            return None
        hit = self._models.get(provider_id)
        if hit is None or time.monotonic() - hit.fetched_at >= ttl:
            return None
        return hit

    async def _listing(self, provider_id: str, *, refresh: bool) -> ModelListing:
        if not refresh:
            hit = self._fresh(provider_id)
            if hit is not None:
                return hit

        # 같은 프로바이더를 동시에 두 번 부르지 않는다. 먼저 시작한 조회에 붙는다.
        # 끝나면 스스로 목록에서 빠진다(콜백) — 요청이 취소돼도 남아 있지 않게.
        task = self._inflight.get(provider_id)
        if task is None:
            task = asyncio.create_task(self._fetch(provider_id))
            self._inflight[provider_id] = task
            task.add_done_callback(
                lambda done, pid=provider_id: self._inflight.pop(pid, None)
            )
        # shield 로 감싸는 이유: 한 클라이언트가 연결을 끊어도 다른 대기자의 조회가
        # 함께 취소되면 안 된다.
        listing = await asyncio.shield(task)
        self._models[provider_id] = listing
        return listing

    async def catalog(
        self, provider_id: str | None = None, *, refresh: bool = False
    ) -> list[ModelListing]:
        """
        프로바이더별 모델 목록. 이름을 주면 그 하나만, 안 주면 전부.

        전부일 때는 **동시에** 조회한다 — 9곳을 차례로 부르면 가장 느린 곳이 아니라
        전부의 합만큼 기다리게 된다. 실패한 곳은 자기 결과에 사유를 담고 빠진다.
        """
        if provider_id:
            # 모르는 이름이면 여기서 400 으로 죽는다 (조회하지 않는다).
            self._spec(provider_id)
            ids = [provider_id]
        else:
            ids = list(self._cfg.require_section("providers").keys())
        return list(
            await asyncio.gather(*(self._listing(pid, refresh=refresh) for pid in ids))
        )

    def models_view(self, listings: list[ModelListing], locale: str | None) -> list[dict]:
        """
        `/v1/models` 응답에 실을 모양. 문구는 카탈로그가 만든다 — 여기 문장이 없다.

        `default_model` 을 함께 싣는 이유는 목록 조회가 실패해도 클라이언트가 무엇이
        쓰일지는 알 수 있어야 하기 때문이다. 그것이 폴백이다.
        """
        now = time.monotonic()
        providers = self._cfg.require_section("providers")
        out = []
        for item in listings:
            spec = providers.get(item.provider) or {}
            out.append({
                "id": item.provider,
                "label": spec.get("label", item.provider),
                "default_model": spec.get("default_model") or None,
                "models": item.models,
                # 조회에 성공했는가. 프로바이더 자체의 사용 가능 여부(`/v1/config` 의
                # providers[].available)와 다른 값이다 — 키는 있는데 목록만 실패할 수 있다.
                "ok": item.ok,
                "reason": None if item.ok else item.error.message(locale),
                "error": None if item.ok else {
                    "code": item.error.code,
                    "params": item.error.json_params(),
                },
                # 이 목록이 얼마나 묵은 것인가(초). 클라이언트가 새로 고칠 판단에 쓴다.
                "age_s": round(max(0.0, now - item.fetched_at), 1),
            })
        return out

    async def prefetch_models(self) -> None:
        """
        기동 직후 캐시를 채운다. 첫 사용자가 기다리지 않게 하려는 것뿐이므로
        **실패해도 아무 일도 일어나지 않는다** — 조회 실패는 이미 결과에 담긴다.
        """
        try:
            listings = await self.catalog()
        except Exception as exc:   # 설정이 깨진 경우 등. 기동을 막지 않는다.
            log.warning("Model prefetch did not run: %s", exc)
            return
        log.info(
            "Model prefetch complete — %s",
            ", ".join(
                f"{i.provider}:{len(i.models) if i.ok else 'failed'}" for i in listings
            ),
        )


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
                "llm.unknown_style", status=400, style=style_name, available=listing(styles)
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
