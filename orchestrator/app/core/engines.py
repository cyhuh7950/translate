"""
엔진 레지스트리.

오케스트레이터는 엔진을 자기 안에 품지 않는다. 전부 원격 HTTP 엔드포인트로만 다룬다.
그 주소에 어떻게 닿는지(프록시+서브도메인 / 포트 직접 / 컨테이너 이름 / 사설망)는
설정에 적힌 URL 문자열이 전부이고, 여기서는 구분하지 않는다.

엔진 하나에 엔드포인트를 여러 개 달 수 있다. `when` 조건이 맞는 것 중 `priority` 가
낮은 것부터 쓴다. 조건 평가기는 레지스트리에 등록되므로 새 조건을 추가할 때
이 파일을 고칠 필요가 없다.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

from . import registry
from .config import Config, ConfigError

log = logging.getLogger("engines")

# 엔드포인트 선택 조건 평가기가 등록되는 종류 이름
CONDITION_KIND = "endpoint_condition"


class EngineError(Exception):
    pass


@dataclass
class Endpoint:
    url: str
    priority: int
    when: dict[str, Any] = field(default_factory=dict)
    api_key_env: str | None = None

    @property
    def api_key(self) -> str:
        """키 값은 설정 파일이 아니라 환경변수(secrets.env)에서 온다."""
        if not self.api_key_env:
            return ""
        return os.environ.get(self.api_key_env, "").strip()

    def matches(self, context: dict[str, Any]) -> bool:
        """조건이 없으면 항상 후보. 있으면 등록된 평가기가 모두 참이어야 한다."""
        for key, expected in self.when.items():
            evaluator = registry.resolve(CONDITION_KIND, key)
            if not evaluator(expected, context):
                return False
        return True


@dataclass
class Engine:
    id: str
    kind: str                      # stt | tts | (확장 가능)
    adapter: str                   # 이 엔진의 API 방언. 레지스트리에서 찾는 이름이다.
    server: str
    modes: list[str]
    streaming: bool
    endpoints: list[Endpoint]

    # 헬스 폴링 결과 — 설정이 아니라 관측된 상태다
    available: bool = False
    ready: bool = False
    last_error: str | None = None
    info: dict[str, Any] = field(default_factory=dict)

    def select_endpoint(self, context: dict[str, Any]) -> Endpoint:
        # 조건 평가기가 이 엔진 자신의 정보도 볼 수 있게 얹어준다.
        ctx = {**context, "engine_server": self.server, "engine_id": self.id}
        candidates = [e for e in self.endpoints if e.matches(ctx)]
        if not candidates:
            raise EngineError(
                f"Engine '{self.id}' has no endpoint matching the current conditions "
                f"(context={ctx})"
            )
        return sorted(candidates, key=lambda e: e.priority)[0]

    def supports(self, mode: str) -> bool:
        return mode in self.modes

    def public_view(self) -> dict:
        """클라이언트에 내보내는 형태. URL 과 키는 노출하지 않는다."""
        return {
            "id": self.id,
            "kind": self.kind,
            "server": self.server,
            "modes": list(self.modes),
            "streaming": self.streaming,
            "available": self.available,
            "ready": self.ready,
            "model": self.info.get("model"),
            "languages": self.info.get("languages"),
            # 보이스 목록도 관측값이다. 엔진이 /info 로 알려주는 것을 그대로 넘기므로
            # 클라이언트가 "F1, M2 ..." 같은 목록을 들고 있을 이유가 없다.
            "voices": self.info.get("voices"),
            "default_voice": self.info.get("default_voice"),
            "error": self.last_error,
        }


def _parse_endpoint(raw: dict, engine_id: str) -> Endpoint:
    url = (raw.get("url") or "").strip()
    if not url:
        raise ConfigError(f"An endpoint of engine '{engine_id}' has no url")
    return Endpoint(
        url=url.rstrip("/"),
        priority=int(raw.get("priority", 100)),
        when=dict(raw.get("when") or {}),
        api_key_env=raw.get("api_key_env"),
    )


def _parse_engine(raw: dict) -> Engine:
    eid = (raw.get("id") or "").strip()
    if not eid:
        raise ConfigError("An engine entry has no id")
    kind = (raw.get("kind") or "").strip()
    if not kind:
        raise ConfigError(f"Engine '{eid}' has no kind")
    endpoints = raw.get("endpoints") or []
    if not endpoints:
        raise ConfigError(f"Engine '{eid}' has no endpoints")
    modes = raw.get("modes")
    if not modes:
        raise ConfigError(
            f"Engine '{eid}' has no modes. "
            f"The operator must set them based on measured performance "
            f"(the system does not infer them)"
        )
    adapter = (raw.get("adapter") or "").strip()
    if not adapter:
        raise ConfigError(
            f"Engine '{eid}' has no adapter. You must specify that engine's API dialect"
        )
    return Engine(
        id=eid,
        kind=kind,
        adapter=adapter,
        server=(raw.get("server") or "").strip(),
        modes=list(modes),
        streaming=bool(raw.get("streaming", False)),
        endpoints=[_parse_endpoint(e, eid) for e in endpoints],
    )


class EngineRegistry:
    """설정에서 엔진 목록을 읽고, 가용성을 관측하고, 조건에 맞는 엔드포인트를 고른다."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._engines: dict[str, Engine] = {}
        self.load()

    def load(self) -> None:
        raw = self._cfg.get("engines")
        if not isinstance(raw, list):
            raise ConfigError("engines must be a list")
        engines = {}
        for item in raw:
            e = _parse_engine(item)
            if e.id in engines:
                raise ConfigError(f"Duplicate engine id: {e.id}")
            engines[e.id] = e
        # 이전 관측 상태는 유지한다 — 설정만 바뀌었을 뿐 엔진이 죽은 것은 아니다
        for eid, old in self._engines.items():
            if eid in engines:
                engines[eid].available = old.available
                engines[eid].ready = old.ready
                engines[eid].info = old.info
        self._engines = engines
        log.info("Loaded %d engines: %s", len(engines), ", ".join(engines) or "(none)")

    # ---- 조회 -------------------------------------------------------------

    def get(self, engine_id: str) -> Engine:
        try:
            return self._engines[engine_id]
        except KeyError:
            raise EngineError(
                f"Unknown engine: '{engine_id}'. "
                f"Available: {', '.join(self._engines) or '(none)'}"
            ) from None

    def list(
        self,
        *,
        kind: str | None = None,
        mode: str | None = None,
        available_only: bool = False,
    ) -> list[Engine]:
        out = list(self._engines.values())
        if kind:
            out = [e for e in out if e.kind == kind]
        if mode:
            out = [e for e in out if e.supports(mode)]
        if available_only:
            out = [e for e in out if e.available and e.ready]
        return out

    def context(self) -> dict[str, Any]:
        """엔드포인트 조건 평가에 넘길 현재 상황."""
        return {"server_id": self._cfg.get("server.id")}

    def endpoint_for(self, engine: Engine) -> Endpoint:
        return engine.select_endpoint(self.context())

    # ---- 가용성 관측 -------------------------------------------------------

    async def probe(self, engine: Engine, client: httpx.AsyncClient) -> None:
        """/health 와 /info 를 물어 상태를 갱신한다. 실패는 오류가 아니라 상태다."""
        try:
            ep = self.endpoint_for(engine)
        except EngineError as exc:
            engine.available = False
            engine.last_error = str(exc)
            return

        headers = {"Authorization": f"Bearer {ep.api_key}"} if ep.api_key else {}
        timeout = float(self._cfg.get("engine_health.timeout_s"))

        try:
            r = await client.get(f"{ep.url}/health", timeout=timeout)
            body = r.json() if r.content else {}
            engine.available = True
            engine.ready = bool(body.get("ready"))
            engine.last_error = None if engine.ready else body.get("error") or "loading"
        except Exception as exc:
            engine.available = False
            engine.ready = False
            engine.last_error = f"{type(exc).__name__}: {exc}"
            return

        # /info 는 인증이 필요하고 부가 정보일 뿐이라 실패해도 무시한다
        try:
            r = await client.get(f"{ep.url}/info", headers=headers, timeout=timeout)
            if r.status_code == 200:
                engine.info = r.json()
        except Exception:
            pass

    async def probe_all(self) -> None:
        async with httpx.AsyncClient() as client:
            await asyncio.gather(
                *(self.probe(e, client) for e in self._engines.values()),
                return_exceptions=True,
            )

    async def poll_forever(self) -> None:
        interval = float(self._cfg.get("engine_health.poll_interval_s"))
        if interval <= 0:
            log.info("Engine health polling disabled (poll_interval_s=%s)", interval)
            return
        while True:
            try:
                await self.probe_all()
            except Exception as exc:
                log.error("Engine health polling error: %s", exc)
            await asyncio.sleep(interval)

    def snapshot(self) -> list[dict]:
        return [e.public_view() for e in self._engines.values()]
