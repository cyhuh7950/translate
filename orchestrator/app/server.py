"""
오케스트레이터 HTTP 서버 — 조립만 한다.

여기 있는 것은 **어느 기능에도 속하지 않는 것들**뿐이다.

    /health          살아 있는가
    /v1/config       클라이언트가 UI 를 그리는 근거 (모듈들이 자기 섹션을 얹는다)
    /v1/models       프로바이더가 실제로 내주는 모델 목록
    /v1/speakers/*   음성 등록 — 어느 모듈이든 쓰므로 core 다
    /v1/admin/*      설정 리로드·오버라이드

기능은 `app/modules/` 아래 폴더로 붙는다. 이 파일은 그 목록을 알지 못한다 —
패키지를 훑어 자동 등록되고, 각 모듈이 자기 라우터와 `/v1/config` 섹션을 낸다.
계약은 `app/core/moduleapi.py` 를 볼 것.

`GET /v1/config` 가 이 골격의 핵심이다. 클라이언트는 이 응답만 보고 UI 를 그린다.
엔진 목록도, 프로바이더 목록도, 프로필(단방향/양방향)도 클라이언트에 하드코딩하지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Query,
    Request,
    UploadFile,
    WebSocket,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .core import i18n, messages, moduleapi, registry
from .core.adapters.audio_filter._base import AUDIO_FILTER_KIND
from .core.adapters.routing.policies import ROUTING_KIND
from .core.adapters.speaker_id._base import SPEAKER_ID_KIND
from .core.adapters.speaker_policy._base import SPEAKER_POLICY_KIND
from .core.adapters.turn.policies import TURN_KIND
from .core.adapters.vad._base import VAD_KIND
from .core.config import Config, ConfigError
from .core.engines import EngineRegistry
from .core.errors import AppError, jsonable
from .core.i18n import localize
from .core.llm import ProviderRegistry, Translator
from .core.moduleapi import ModuleContext
from .core.sessions import ProfileRegistry
from .core.speech import SpeechService
from .core.voiceprints import SpeakerEngine, VoicePrintError, VoicePrintStore

log = logging.getLogger("orchestrator")

# 어댑터가 사는 패키지. 여기 파일을 넣으면 자동으로 등록된다 — 목록을 코드에 나열하지 않는다.
ADAPTER_PACKAGE = "app.core.adapters"

# 기능 모듈이 사는 패키지. 여기 폴더를 넣으면 자동으로 등록된다 — 마찬가지다.
MODULE_PACKAGE = "app.modules"

# 설정 디렉터리는 환경변수로만 받는다. 이것 하나만은 부트스트랩이라 코드가 알아야 한다.
CONFIG_DIR_ENV = "TRANSLATE_CONFIG_DIR"


class State:
    """앱이 들고 있는 공용 서비스들. 설정이 바뀌면 통째로 다시 만든다."""

    def __init__(self, config_dir: str):
        self.config = Config(config_dir)
        self.engines = EngineRegistry(self.config)
        self.profiles = ProfileRegistry(self.config)
        self.providers = ProviderRegistry(self.config)
        self.translator = Translator(self.config, self.providers)
        # 명시적으로 등록된 목소리(파일)와 그것을 만들어 주는 엔진 호출부.
        # 자동 등록분은 여기 오지 않는다 — WS 세션의 메모리에만 산다.
        self.voiceprints = VoicePrintStore(self.config)
        self.speaker_engine = SpeakerEngine(self.config, self.engines)
        # 오디오↔텍스트와 화자 식별. 흐름에 종속되지 않는 단계라 core 에 있고,
        # 모듈(번역·문서 음성화·학습·대화)이 전부 이것을 쓴다.
        self.speech = SpeechService(
            self.config, self.engines, self.voiceprints, self.speaker_engine
        )

    def rebuild(self) -> None:
        """
        설정이 바뀐 뒤 설정에서 만들어진 것들을 다시 만든다.

        설정을 갈아끼우는 경로가 셋(파일 변경 감지·`/v1/admin/reload`·`/v1/admin/config`)
        이라 한 곳에 모아 둔다. 갈라 두면 어느 한 경로에서만 반영되지 않는 것이 생긴다 —
        실제로 프로바이더 캐시가 관리 API 경로에서만 살아남는 문제가 있었다.
        """
        self.engines.load()
        self.profiles.load()
        # base_url·모델·상류 오류 노출 여부가 바뀌었을 수 있다. 어댑터는 캐시된다.
        self.providers.invalidate()

    def reload_if_changed(self) -> bool:
        if not self.config.maybe_reload():
            return False
        self.rebuild()
        return True


def _languages_view(cfg: Config, locale: str | None) -> list[dict]:
    """
    선택 가능한 번역 언어. 목록도 표시 이름도 languages.yaml 에서 온다.

    label 은 로케일 맵일 수 있으므로 프로필과 같은 방식으로 표시 언어에 맞춰 푼다.
    label 이 없으면 code 를 그대로 쓴다 — 언어 하나 늘리자고 모든 로케일을
    채우게 만들지 않기 위해서다.
    """
    out = []
    for item in cfg.get("languages"):
        code = (item.get("code") or "").strip()
        if not code:
            raise ConfigError("languages.no_code")
        out.append({"code": code, "label": localize(item.get("label"), locale) or code})
    return out


def request_locale(request: Request) -> str:
    """
    요청의 표시 언어. `?locale=` > `Accept-Language` > 기본어(en).

    `/v1/config` 와 오류 봉투가 같은 규칙을 써야 한다. 규칙이 갈리면 사용자는
    화면은 한국어인데 오류만 영어인 상태를 보게 된다.
    """
    return i18n.resolve(
        request.query_params.get("locale"), request.headers.get("accept-language")
    )


def error_body(code: str, params: dict, locale: str) -> dict:
    """
    오류 응답 봉투. **`detail` 은 문자열로 유지한다.**

    기존 클라이언트(웹·curl)가 `detail` 하나만 보고 동작하기 때문이다. 기계가 읽을
    코드와 파라미터는 옆에 `error` 로 따로 싣는다 — 문구를 파싱하게 만들지 않는다.
    """
    return {
        "detail": messages.render(code, params, locale),
        "error": {"code": code, "params": params},
    }


def _config_dir() -> str:
    path = os.environ.get(CONFIG_DIR_ENV, "").strip()
    if not path:
        raise ConfigError("config.dir_env_required", env=CONFIG_DIR_ENV)
    return path


def create_app() -> FastAPI:
    # 어댑터를 먼저 등록해야 프로필 가용성 판단이 정확하다.
    # main() 이 아니라 여기서 부르는 이유는, uvicorn 이 팩토리로 직접 부를 수도 있기 때문.
    registry.discover(ADAPTER_PACKAGE)
    moduleapi.discover(MODULE_PACKAGE)

    state = State(_config_dir())
    cfg = state.config
    # 모듈은 create_app() 안에서 만들어지지만 lifespan 은 그 뒤에 돈다.
    # 리스트를 미리 두고 채우는 이유가 그것이다.
    modules: list[moduleapi.Module] = []

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        tasks = []
        if cfg.get("engine_health.probe_on_start"):
            await state.engines.probe_all()
        interval = float(cfg.get("engine_health.poll_interval_s"))
        if interval > 0:
            tasks.append(asyncio.create_task(state.engines.poll_forever()))
        tasks.append(asyncio.create_task(_watch_config(state)))
        # 모델 목록을 미리 받아 캐시를 채운다. **기다리지 않는다** — 기동이 프로바이더
        # 9곳의 응답에 묶이면 안 된다. 실패는 목록 요청 때 사유로 나온다.
        if cfg.get("llm.models_prefetch_on_start"):
            tasks.append(asyncio.create_task(state.providers.prefetch_models()))
        try:
            for mod in modules:
                await mod.startup()
            yield
        finally:
            for mod in modules:
                try:
                    await mod.shutdown()
                except Exception as exc:   # 한 모듈이 죽어도 나머지는 정리한다
                    log.error("Module '%s' failed to shut down: %s", mod.name, exc)
            for t in tasks:
                t.cancel()

    app = FastAPI(
        title="translate orchestrator",
        version="0.1.0",
        description="STT → LLM → TTS speech translation orchestrator",
        lifespan=lifespan,
    )
    app.state.ctx = state

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.get("server.cors_origins"),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- 오류 봉투 ---------------------------------------------------------
    #
    # 봉투는 여기 한 곳에서만 만들어진다. 라우트는 코드와 파라미터를 든 예외를
    # 던지기만 하면 되고, 문구는 요청 로케일이 확정되는 이 자리에서 렌더된다.

    @app.exception_handler(AppError)
    async def _on_app_error(request: Request, exc: AppError) -> JSONResponse:
        if exc.status >= 500:
            log.error("[%s] %s", exc.code, exc)
        return JSONResponse(
            error_body(exc.code, exc.json_params(), request_locale(request)),
            status_code=exc.status,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _on_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        """
        프레임워크가 만든 오류(없는 경로, 허용되지 않은 메서드 …).

        코드는 `http.<상태>` 로 조립된다. 카탈로그에 그 상태의 문구를 넣으면 소스를
        고치지 않고도 문장이 붙고, 없으면 `http.error` 로 떨어진다.
        """
        code = f"http.{exc.status_code}"
        params = {
            "status": exc.status_code,
            "detail": jsonable(exc.detail),
            "method": request.method,
            "path": request.url.path,
        }
        if not messages.has(code):
            code = "http.error"
        return JSONResponse(
            error_body(code, params, request_locale(request)),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def _on_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """
        본문 검증 실패. 기본 핸들러는 detail 을 배열로 내보내므로 여기서 맞춘다.

        pydantic 의 원본 오류를 그대로 싣지 않는 이유는 두 가지다. 파이썬 repr 이
        그대로 문장에 들어가 읽히지 않고, `input` 에 요청 본문이 통째로 되돌아온다.
        어느 필드가 왜 틀렸는지만 남긴다.
        """
        fields = [
            {
                "loc": ".".join(str(part) for part in (item.get("loc") or ())),
                "msg": str(item.get("msg") or ""),
                "type": str(item.get("type") or ""),
            }
            for item in exc.errors()
        ]
        params = {
            "status": 422,
            "fields": fields,
            "summary": "; ".join(f"{f['loc']}: {f['msg']}" for f in fields),
        }
        return JSONResponse(
            error_body("http.422", params, request_locale(request)), status_code=422
        )

    auth = Depends(_auth_dependency(state))

    # 모듈이 받는 공용 서비스 묶음. 모듈은 이것만 알고 server.py 를 알지 못한다.
    ctx = ModuleContext(
        config=state.config,
        engines=state.engines,
        profiles=state.profiles,
        providers=state.providers,
        translator=state.translator,
        speech=state.speech,
        voiceprints=state.voiceprints,
        speaker_engine=state.speaker_engine,
        auth=auth,
        ws_authorized=lambda ws: _ws_authorized(state, ws),
        reload_if_changed=state.reload_if_changed,
    )
    modules.extend(moduleapi.build(ctx))
    app.state.modules = modules

    # ---- 상태 -------------------------------------------------------------

    @app.get("/health", summary="Health check (no authentication required)")
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

    @app.get("/v1/config", summary="What is available right now", dependencies=[auth])
    async def config_view(
        request: Request,
        locale: str | None = Query(
            None, description="Display language (e.g. en, ko). Falls back to Accept-Language, then en"
        ),
    ) -> dict:
        """
        Everything the client needs to render its UI: profiles, engines, providers
        and registered implementations. Human-readable labels are returned in the
        resolved display language.
        """
        state.reload_if_changed()
        c = state.config
        # 표시 언어 규칙은 오류 봉투와 같은 것을 쓴다 (request_locale).
        # `locale` 파라미터를 선언해 두는 것은 OpenAPI 문서에 드러내기 위해서다.
        want_locale = request_locale(request)
        body = {
            "server_id": c.get("server.id"),
            "locale": want_locale,
            "session": {
                "default_profile": c.get("session.default_profile"),
                "default_mode": c.get("session.default_mode"),
                "allow_profile_override": c.get("session.allow_profile_override"),
                "allow_mode_override": c.get("session.allow_mode_override"),
                "default_source_lang": c.get("session.default_source_lang"),
                "default_target_lang": c.get("session.default_target_lang"),
            },
            # 번역 언어 선택지. 클라이언트에 언어 목록을 두지 않기 위해 여기서 내보낸다.
            "languages": _languages_view(c, want_locale),
            # 단방향/양방향 선택지. 이름도 label 도 설정 파일에서 온다.
            "profiles": state.profiles.public_view(want_locale),
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
                "stt_channels": c.get("audio.stt_channels"),
                "tts_response_format": c.get("audio.tts_response_format"),
            },
            "vad": {
                "backend": c.get("vad.backend"),
                "available": registry.available(VAD_KIND),
                "silence_ms": c.get("vad.silence_ms"),
                "min_speech_ms": c.get("vad.min_speech_ms"),
            },
            # 배경 음성 게이트. 두 입력 경로(PTT·핸즈프리)에 같은 구현이 걸린다.
            "audio_filter": {
                "enabled": c.get("audio_filter.enabled"),
                "implementation": c.get("audio_filter.implementation"),
                "available": registry.available(AUDIO_FILTER_KIND),
            },
            "turn": {
                "default_policy": c.get("session.default_turn_policy"),
                "available": registry.available(TURN_KIND),
            },
            # 화자 식별. 클라이언트는 이 값들로 "등록된 목소리 N개 / 정책 X" 같은
            # UI 를 그린다. ★ 임베딩 자체는 어떤 경우에도 여기로 나가지 않는다.
            "speaker_id": {
                "default": c.get("session.default_speaker_id"),
                "available": registry.available(SPEAKER_ID_KIND),
                "policy": c.get("speaker_id.policy"),
                "policies": registry.available(SPEAKER_POLICY_KIND),
                "threshold": c.get("speaker_id.threshold"),
                "auto_enroll": c.get("speaker_id.auto_enroll.enabled"),
                "enrolled": state.voiceprints.count(),
                "store_error": state.voiceprints.status()["error"],
            },
            # 클라이언트 입력 방식(누르고 말하기 / 핸즈프리)의 목록과 기본값.
            # 목록을 클라이언트에 하드코딩하지 않기 위해 여기서 내보낸다.
            "client": {
                "input_modes": c.get("client.input_modes"),
                "default_input_mode": c.get("client.default_input_mode"),
            },
        }
        # 모듈 기여. 각 모듈이 자기 섹션을 싣는다 — 그래야 모듈의 클라이언트 UI 도
        # 이 응답만 보고 그려진다. 키가 core 와 겹치면 여기서 죽는다.
        body.update(
            moduleapi.config_sections(
                modules, want_locale, reserved={k: "core" for k in body}
            )
        )
        return body

    @app.get(
        "/v1/models",
        summary="Models the providers actually offer",
        dependencies=[auth],
    )
    async def list_models(
        request: Request,
        provider: str | None = Query(
            None, description="Only this provider. Omit to ask every configured provider"
        ),
        refresh: bool = Query(False, description="Ignore the cache and ask the providers again"),
        locale: str | None = Query(None, description="Display language for failure reasons"),
    ) -> dict:
        """
        Asks the providers directly instead of hardcoding model names in the code or client.

        This is a **separate endpoint on purpose**: `/v1/config` is fetched on every app
        start, and querying nine providers there would make every start that much slower.
        Results are cached for `llm.models_cache_ttl_s`; providers are queried
        concurrently, so one dead provider never blocks the others — it comes back with
        its own `reason` instead.
        """
        state.reload_if_changed()
        # 실패 사유의 표시 언어는 오류 봉투와 같은 규칙을 쓴다.
        want_locale = request_locale(request)
        # 모르는 프로바이더 이름이면 LLMError(400) 가 봉투 핸들러로 올라간다.
        listings = await state.providers.catalog(provider, refresh=refresh)
        return {
            "locale": want_locale,
            "cache_ttl_s": state.config.get("llm.models_cache_ttl_s"),
            "default_provider": state.config.get("llm.default_provider"),
            "providers": state.providers.models_view(listings, want_locale),
        }

    # ---- 음성 등록 (voice print) --------------------------------------------
    #
    # 어느 모듈이든 화자를 알아야 할 수 있으므로 core 에 둔다.
    #
    # ★ 여기서 만들어지는 임베딩은 생체정보에 준하는 개인정보다. 목록 응답에는
    #   절대 벡터를 싣지 않는다 (app/core/voiceprints.py 의 주석을 볼 것).

    @app.get("/v1/speakers", summary="Enrolled voice prints", dependencies=[auth])
    async def list_speakers() -> dict:
        """
        Voices enrolled on this server, without the embeddings themselves.

        Voices learned automatically during a live session are NOT listed here:
        they only ever exist in that session's memory and disappear with it.
        """
        state.reload_if_changed()
        c = state.config
        status = state.voiceprints.status()
        return {
            "policy": c.get("speaker_id.policy"),
            "threshold": c.get("speaker_id.threshold"),
            "auto_enroll": c.get("speaker_id.auto_enroll.enabled"),
            "count": status["count"],
            "error": status["error"],
            "speakers": [vp.public() for vp in state.voiceprints.list()],
        }

    @app.post(
        "/v1/speakers/enroll",
        summary="Enroll or replace a voice print",
        dependencies=[auth],
    )
    async def enroll_speaker(
        request: Request,
        speaker_id: str = Form(
            ..., description="Participant id this voice belongs to (e.g. a, b, speaker)"
        ),
        name: str | None = Form(None, description="Display name. Defaults to the id"),
        mode: str | None = Form(None, description="Session mode used to route the speaker engine"),
        files: list[UploadFile] = File(
            ..., description="Utterances of this person. More utterances give a steadier print"
        ),
    ) -> dict:
        """
        Averages the embeddings of the uploaded utterances and stores the result.

        An existing entry with the same id is replaced. `min_pairwise_similarity`
        reports how alike the uploaded utterances were: a low value usually means
        one of them is somebody else.
        """
        state.reload_if_changed()
        c = state.config

        limit = int(c.get("server.max_upload_bytes"))
        payload: list[tuple[str, bytes, str]] = []
        total = 0
        for f in files:
            data = await f.read()
            if not data:
                continue
            total += len(data)
            payload.append((
                f.filename or c.get("audio.pcm_filename"),
                data,
                f.content_type or "application/octet-stream",
            ))
        if total > limit:
            raise AppError("audio.too_large", status=413, size=total, limit=limit)

        minimum = int(c.get("speaker_id.min_enroll_files"))
        if len(payload) < minimum:
            raise AppError(
                "speaker.enroll_needs_files",
                status=400,
                speaker_id=speaker_id,
                minimum=minimum,
                count=len(payload),
            )

        # 엔진·레지스트리·저장소 오류는 전부 코드와 상태를 들고 있으므로 그대로 올린다.
        body = await state.speaker_engine.enroll(
            mode=mode or c.get("session.default_mode"), files=payload
        )

        vp = state.voiceprints.put(
            speaker_id=speaker_id,
            name=name or speaker_id,
            embedding=body["embedding"],
            utterances=int(body.get("count") or len(payload)),
            dim=int(body.get("dim") or 0),
            engine=str(body.get("engine") or ""),
            model=str(body.get("model") or ""),
        )

        threshold = float(c.get("speaker_id.threshold"))
        spread = body.get("min_pairwise_similarity")
        warning = None
        if spread is not None and float(spread) < threshold:
            # 오류는 아니지만 사용자에게 보이는 문구다. 오류와 같은 카탈로그를 쓴다.
            warning = messages.render(
                "speaker.enroll_spread_low",
                {"similarity": f"{float(spread):.2f}", "threshold": threshold},
                request_locale(request),
            )
        return {
            "speaker": vp.public(),
            "min_pairwise_similarity": spread,
            "threshold": threshold,
            "warning": warning,
            "enrolled": state.voiceprints.count(),
        }

    @app.delete(
        "/v1/speakers/{speaker_id}",
        summary="Delete an enrolled voice print",
        dependencies=[auth],
    )
    async def delete_speaker(speaker_id: str) -> dict:
        """Removes the stored embedding immediately."""
        state.reload_if_changed()
        removed = state.voiceprints.delete(speaker_id)
        if not removed:
            raise VoicePrintError(
                "voiceprint.not_enrolled", status=404, speaker_id=speaker_id
            )
        return {"deleted": speaker_id, "enrolled": state.voiceprints.count()}

    @app.post("/v1/admin/reload", summary="Reload configuration", dependencies=[auth])
    async def reload_config() -> dict:
        state.config.reload()
        state.rebuild()
        await state.engines.probe_all()
        return {"status": "reloaded", "engines": len(state.engines.snapshot())}

    @app.post("/v1/admin/config", summary="Override runtime configuration", dependencies=[auth])
    async def patch_config(patch: dict) -> dict:
        """Applied at the highest priority. Takes effect without a restart."""
        state.config.set_runtime(patch)
        state.rebuild()
        return {"status": "applied", "keys": sorted(patch)}

    # ---- 기능 모듈 ---------------------------------------------------------
    #
    # 목록이 여기 없다는 것이 요점이다. 폴더를 넣으면 붙고, 빼면 떨어진다.
    for mod in modules:
        router = mod.routes()
        if router is not None:
            app.include_router(router)
            log.info("Module '%s' mounted %d route(s)", mod.name, len(router.routes))

    return app


def _token_of(headers, query, param: str) -> str:
    """HTTP 와 WS 가 같은 방식으로 키를 찾는다. 규칙이 갈리지 않게 한 곳에 둔다."""
    header = headers.get("authorization", "")
    token = header[7:].strip() if header[:7].lower() == "bearer " else ""
    if not token:
        token = headers.get("x-api-key", "").strip()
    # 쿼리 파라미터는 기본적으로 꺼져 있다(설정의 빈 문자열). URL 은 접근 로그와
    # Referer 에 남으므로 헤더를 붙일 수 있는 경로에서는 쓰지 않는 편이 낫다.
    if not token and param and query is not None:
        token = (query.get(param) or "").strip()
    return token


def _ws_authorized(state: State, ws: WebSocket) -> bool:
    """
    WebSocket 인증. HTTP 와 같은 `auth.api_key` 다.

    브라우저는 WS 핸드셰이크에 헤더를 붙일 수 없지만, 웹 클라이언트는 nginx 를
    거치고 그 nginx 가 Authorization 을 주입하므로 키가 브라우저에 내려가지 않는다.
    프록시 없이 직접 붙는 클라이언트(CLI·앱)는 헤더를 그대로 붙이면 된다.
    """
    cfg = state.config
    key = (cfg.get("auth.api_key") or "").strip()
    if not key:
        return True
    if ws.url.path in cfg.get("auth.public_paths"):
        return True
    return _token_of(ws.headers, ws.query_params, cfg.get("auth.ws_query_param")) == key


def _auth_dependency(state: State):
    async def check(request: Request) -> None:
        cfg = state.config
        key = (cfg.get("auth.api_key") or "").strip()
        if not key:
            return
        if request.url.path in cfg.get("auth.public_paths"):
            return
        # HTTP 는 헤더만 본다. 쿼리 파라미터 대안은 WS 전용이다.
        if _token_of(request.headers, None, "") != key:
            raise AppError("auth.invalid_key", status=401)

    return check


async def _watch_config(state: State) -> None:
    """설정 파일이 바뀌면 재기동 없이 반영한다. 엔진 하나 추가하려고 재시작하지 않기 위해."""
    while True:
        await asyncio.sleep(5)
        try:
            if state.reload_if_changed():
                await state.engines.probe_all()
        except Exception as exc:
            log.error("Config reload failed (keeping the previous config): %s", exc)


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
