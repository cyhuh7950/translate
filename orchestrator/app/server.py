"""
오케스트레이터 HTTP 서버 — 1단계 골격.

지금 있는 것은 설정 로더·레지스트리·엔진 레지스트리·프로필이고,
번역 파이프라인(STT→LLM→TTS)은 다음 단계에서 붙는다.

`GET /v1/config` 가 이 골격의 핵심이다. 클라이언트는 이 응답만 보고 UI 를 그린다.
엔진 목록도, 프로바이더 목록도, 프로필(단방향/양방향)도 클라이언트에 하드코딩하지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import registry
from .adapters.llm._base import LLMError
from .adapters.routing.policies import ROUTING_KIND
from .adapters.speaker_id.manual import SPEAKER_ID_KIND
from .config import Config, ConfigError
from .engines import EngineRegistry
from .llm import LLM_KIND, ProviderRegistry, Translator, Turn
from .sessions import ProfileRegistry

log = logging.getLogger("orchestrator")

# 어댑터가 사는 패키지. 여기 파일을 넣으면 자동으로 등록된다 — 목록을 코드에 나열하지 않는다.
ADAPTER_PACKAGE = "app.adapters"

# 설정 디렉터리는 환경변수로만 받는다. 이것 하나만은 부트스트랩이라 코드가 알아야 한다.
CONFIG_DIR_ENV = "TRANSLATE_CONFIG_DIR"


class State:
    """앱이 들고 있는 것들. 설정이 바뀌면 통째로 다시 만든다."""

    def __init__(self, config_dir: str):
        self.config = Config(config_dir)
        self.engines = EngineRegistry(self.config)
        self.profiles = ProfileRegistry(self.config)
        self.providers = ProviderRegistry(self.config)
        self.translator = Translator(self.config, self.providers)

    def reload_if_changed(self) -> bool:
        if not self.config.maybe_reload():
            return False
        self.engines.load()
        self.profiles.load()
        self.providers.invalidate()   # base_url·모델이 바뀌었을 수 있다
        return True


def _config_dir() -> str:
    path = os.environ.get(CONFIG_DIR_ENV, "").strip()
    if not path:
        raise ConfigError(
            f"{CONFIG_DIR_ENV} 환경변수가 필요합니다. "
            f"설정 디렉터리 경로를 지정하세요 (예: /config)"
        )
    return path


def create_app() -> FastAPI:
    # 어댑터를 먼저 등록해야 프로필 가용성 판단이 정확하다.
    # main() 이 아니라 여기서 부르는 이유는, uvicorn 이 팩토리로 직접 부를 수도 있기 때문.
    registry.discover(ADAPTER_PACKAGE)

    state = State(_config_dir())
    cfg = state.config

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        tasks = []
        if cfg.get("engine_health.probe_on_start"):
            await state.engines.probe_all()
        interval = float(cfg.get("engine_health.poll_interval_s"))
        if interval > 0:
            tasks.append(asyncio.create_task(state.engines.poll_forever()))
        tasks.append(asyncio.create_task(_watch_config(state)))
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()

    app = FastAPI(
        title="translate orchestrator",
        version="0.1.0",
        description="STT → LLM → TTS 음성 번역 오케스트레이터",
        lifespan=lifespan,
    )
    app.state.ctx = state

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.get("server.cors_origins"),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    auth = Depends(_auth_dependency(state))

    # ---- 상태 -------------------------------------------------------------

    @app.get("/health", summary="헬스체크 (인증 불필요)")
    async def health() -> JSONResponse:
        engines = state.engines.snapshot()
        return JSONResponse({
            "status": "ok",
            "server_id": state.config.get("server.id"),
            "engines": {
                "total": len(engines),
                "ready": sum(1 for e in engines if e["ready"]),
            },
        })

    # ---- 클라이언트가 UI 를 그리는 근거 ------------------------------------

    @app.get("/v1/config", summary="지금 사용 가능한 것들", dependencies=[auth])
    async def config_view() -> dict:
        state.reload_if_changed()
        c = state.config
        return {
            "server_id": c.get("server.id"),
            "session": {
                "default_profile": c.get("session.default_profile"),
                "default_mode": c.get("session.default_mode"),
                "allow_profile_override": c.get("session.allow_profile_override"),
                "allow_mode_override": c.get("session.allow_mode_override"),
            },
            # 단방향/양방향 선택지. 이름도 label 도 설정 파일에서 온다.
            "profiles": state.profiles.public_view(),
            "engines": state.engines.snapshot(),
            "llm": {
                "default_provider": c.get("llm.default_provider"),
                "style": c.get("llm.style"),
                "styles": sorted(c.require_section("prompts.styles").keys()),
                "context_turns": c.get("llm.context_turns"),
                "providers": state.providers.public_view(),
            },
            # 등록된 구현체 — 무엇이 실제로 붙어 있는지 그대로 보여준다
            "implementations": registry.snapshot(),
            "routing": {
                "policy": c.get("routing.policy"),
                "available": registry.available(ROUTING_KIND),
            },
            "audio": {
                "stt_sample_rate": c.get("audio.stt_sample_rate"),
                "tts_response_format": c.get("audio.tts_response_format"),
            },
        }

    @app.get("/v1/models", summary="프로바이더가 실제로 제공하는 모델 목록", dependencies=[auth])
    async def list_models(provider: str | None = None) -> dict:
        """모델 이름을 코드나 클라이언트에 박지 않고 프로바이더에 직접 물어본다."""
        pid = provider or state.config.get("llm.default_provider")
        try:
            return {"provider": pid, "models": await state.providers.models(pid)}
        except LLMError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/v1/translate/text", summary="텍스트 번역 (STT/TTS 없이)", dependencies=[auth])
    async def translate_text(req: TextTranslateRequest):
        """LLM 계층만 따로 확인할 때 쓴다. 음성 파이프라인은 이걸 내부적으로 재사용한다."""
        state.reload_if_changed()
        context = [Turn(source=t.source, target=t.target) for t in (req.context or [])]
        kwargs = dict(
            source_lang=req.source_lang,
            target_lang=req.target_lang,
            provider=req.provider,
            model=req.model,
            style=req.style,
            context=context,
            glossary=req.glossary,
        )
        try:
            if req.stream:
                async def gen():
                    async for piece in state.translator.stream(req.text, **kwargs):
                        yield piece
                return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")

            started = asyncio.get_running_loop().time()
            text = await state.translator.translate(req.text, **kwargs)
            elapsed = asyncio.get_running_loop().time() - started
            return {
                "text": text,
                "source_lang": req.source_lang,
                "target_lang": req.target_lang,
                "provider": req.provider or state.config.get("llm.default_provider"),
                "model": req.model,
                "elapsed_s": round(elapsed, 3),
            }
        except LLMError as exc:
            raise HTTPException(502, str(exc)) from exc

    @app.post("/v1/admin/reload", summary="설정 다시 읽기", dependencies=[auth])
    async def reload_config() -> dict:
        state.config.reload()
        state.engines.load()
        state.profiles.load()
        await state.engines.probe_all()
        return {"status": "reloaded", "engines": len(state.engines.snapshot())}

    @app.post("/v1/admin/config", summary="런타임 설정 덮어쓰기", dependencies=[auth])
    async def patch_config(patch: dict) -> dict:
        """가장 높은 우선순위로 얹힌다. 재기동 없이 반영된다."""
        state.config.set_runtime(patch)
        state.engines.load()
        state.profiles.load()
        return {"status": "applied", "keys": sorted(patch)}

    return app


class ContextTurn(BaseModel):
    source: str
    target: str


class TextTranslateRequest(BaseModel):
    """번역 방향은 요청이 정한다. 코드에 언어쌍 상수가 없다."""

    text: str = Field(..., description="번역할 원문")
    source_lang: str = Field(..., description="원문 언어 (예: ko)")
    target_lang: str = Field(..., description="번역 언어 (예: en)")
    provider: str | None = Field(None, description="생략 시 llm.default_provider")
    model: str | None = Field(None, description="생략 시 프로바이더의 default_model")
    style: str | None = Field(None, description="prompts.styles 의 키")
    context: list[ContextTurn] | None = Field(None, description="직전 대화 턴들")
    glossary: dict[str, str] | None = Field(None, description="용어집 (원어 → 번역어)")
    stream: bool = False


def _auth_dependency(state: State):
    async def check(request: Request) -> None:
        cfg = state.config
        key = (cfg.get("auth.api_key") or "").strip()
        if not key:
            return
        if request.url.path in cfg.get("auth.public_paths"):
            return
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header[:7].lower() == "bearer " else ""
        if not token:
            token = request.headers.get("x-api-key", "").strip()
        if token != key:
            raise HTTPException(401, "유효하지 않은 API 키")

    return check


async def _watch_config(state: State) -> None:
    """설정 파일이 바뀌면 재기동 없이 반영한다. 엔진 하나 추가하려고 재시작하지 않기 위해."""
    while True:
        await asyncio.sleep(5)
        try:
            if state.reload_if_changed():
                await state.engines.probe_all()
        except Exception as exc:
            log.error("설정 리로드 실패 (이전 설정을 유지합니다): %s", exc)


def main() -> None:
    import uvicorn

    registry.discover(ADAPTER_PACKAGE)
    app = create_app()
    cfg: Config = app.state.ctx.config

    logging.basicConfig(
        level=str(cfg.get("server.log_level")).upper(),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    uvicorn.run(
        app,
        host=cfg.get("server.host"),
        port=int(cfg.get("server.port")),
        access_log=bool(cfg.get("server.access_log")),
    )


if __name__ == "__main__":
    main()
