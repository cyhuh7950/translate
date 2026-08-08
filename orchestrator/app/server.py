"""
오케스트레이터 HTTP 서버 — 1단계 골격.

지금 있는 것은 설정 로더·레지스트리·엔진 레지스트리·프로필이고,
번역 파이프라인(STT→LLM→TTS)은 다음 단계에서 붙는다.

`GET /v1/config` 가 이 골격의 핵심이다. 클라이언트는 이 응답만 보고 UI 를 그린다.
엔진 목록도, 프로바이더 목록도, 프로필(단방향/양방향)도 클라이언트에 하드코딩하지 않는다.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from contextlib import asynccontextmanager
from urllib.parse import quote

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    WebSocket,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import preprocess, registry
from .adapters.audio_filter._base import AUDIO_FILTER_KIND
from .adapters.llm._base import LLMError
from .adapters.routing.policies import ROUTING_KIND
from .adapters.speaker_id._base import SPEAKER_ID_KIND, SpeakerIdError
from .adapters.speaker_policy._base import SPEAKER_POLICY_KIND
from .adapters.turn.policies import TURN_KIND
from .adapters.vad._base import VAD_KIND
from .config import Config, ConfigError
from .engines import EngineError, EngineRegistry
from .i18n import localize
from .i18n import normalize as normalize_locale
from .llm import LLM_KIND, ProviderRegistry, Translator, Turn
from .pipeline import Pipeline
from .registry import RegistryError
from .sessions import ProfileRegistry, SessionError
from .streaming import StreamHandler
from .voiceprints import SpeakerEngine, VoicePrintError, VoicePrintStore

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
        # 명시적으로 등록된 목소리(파일)와 그것을 만들어 주는 엔진 호출부.
        # 자동 등록분은 여기 오지 않는다 — WS 세션의 메모리에만 산다.
        self.voiceprints = VoicePrintStore(self.config)
        self.speaker_engine = SpeakerEngine(self.config, self.engines)
        self.pipeline = Pipeline(
            self.config, self.engines, self.translator, self.voiceprints, self.speaker_engine
        )

    def reload_if_changed(self) -> bool:
        if not self.config.maybe_reload():
            return False
        self.engines.load()
        self.profiles.load()
        self.providers.invalidate()   # base_url·모델이 바뀌었을 수 있다
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
            raise ConfigError("A languages entry has no code")
        out.append({"code": code, "label": localize(item.get("label"), locale) or code})
    return out


def _config_dir() -> str:
    path = os.environ.get(CONFIG_DIR_ENV, "").strip()
    if not path:
        raise ConfigError(
            f"The {CONFIG_DIR_ENV} environment variable is required. "
            f"Set it to the config directory path (e.g. /config)"
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

    auth = Depends(_auth_dependency(state))

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
        # 표시 언어 우선순위: ?locale= > Accept-Language > 기본어(en)
        want_locale = normalize_locale(locale or request.headers.get("accept-language"))
        return {
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
            # WebSocket 스트리밍. 클라이언트는 이 값들로 마이크 캡처 규격을 맞춘다.
            "stream": {
                "path": c.get("stream.path"),
                "input_format": c.get("stream.input_format"),
                "client_frame_ms": c.get("stream.client_frame_ms"),
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

    @app.post(
        "/v1/translate/audio",
        summary="Speech → translated speech (batch/PTT)",
        dependencies=[auth],
    )
    async def translate_audio(
        file: UploadFile = File(..., description="Audio file (wav/mp3/webm/m4a, etc.)"),
        source_lang: str = Form(...),
        target_lang: str = Form(...),
        profile: str | None = Form(None, description="Session profile. Defaults if omitted"),
        mode: str | None = Form(None),
        speaker: str | None = Form(None, description="Participant id of the speaker"),
        stt_engine: str | None = Form(None),
        tts_engine: str | None = Form(None),
        voice: str | None = Form(None),
        speed: float | None = Form(None),
        response_format: str | None = Form(None),
        provider: str | None = Form(None),
        model: str | None = Form(None),
        style: str | None = Form(None),
        with_audio: bool = Form(True, description="If False, text only (TTS skipped)"),
        response_mode: str | None = Form(None, description="json | binary"),
    ):
        state.reload_if_changed()
        c = state.config

        try:
            session = state.profiles.create(
                profile=profile, mode=mode, source_lang=source_lang, target_lang=target_lang
            )
        except SessionError as exc:
            raise HTTPException(400, str(exc)) from exc

        audio = await file.read()
        if not audio:
            raise HTTPException(400, "Empty audio")
        limit = int(c.get("server.max_upload_bytes"))
        if len(audio) > limit:
            raise HTTPException(413, f"Audio is too large ({len(audio)} > {limit} bytes)")

        # 배경 음성 게이트. 옆에서 TV 가 나오는 환경에서 사용자가 말을 쉬는 구간이
        # STT 로 넘어가 그대로 받아적히는 것을 막는다. 핸즈프리(WS)도 같은 구현을 쓴다.
        # 꺼져 있으면 바이트가 손대지 않은 채 그대로 지나간다.
        audio, filename, content_type, gate_metrics = await preprocess.filter_upload(
            c,
            audio,
            file.filename or c.get("audio.pcm_filename"),
            file.content_type or "application/octet-stream",
        )

        try:
            result = await state.pipeline.run_audio(
                session,
                audio=audio,
                filename=filename,
                content_type=content_type,
                speaker_hint=speaker,
                stt_engine=stt_engine,
                tts_engine=tts_engine,
                voice=voice,
                speed=float(speed if speed is not None else c.get("audio.tts_speed")),
                response_format=response_format or c.get("audio.tts_response_format"),
                provider=provider,
                model=model,
                style=style,
                with_audio=with_audio,
            )
        except (SessionError, SpeakerIdError) as exc:
            raise HTTPException(400, str(exc)) from exc
        except (EngineError, LLMError) as exc:
            raise HTTPException(502, str(exc)) from exc
        except RegistryError as exc:
            raise HTTPException(500, str(exc)) from exc

        # 게이트가 얼마나 잘라냈는지는 응답의 metrics 로 나간다. 튜닝의 근거다.
        result.metrics.update(gate_metrics)

        wants = response_mode or c.get("audio.response_mode")
        audible = [d for d in result.deliveries if d.audio]

        # 수신자가 하나뿐이고 오디오가 있으면 바이트를 그대로 돌려줄 수 있다.
        if wants == "binary" and len(audible) == 1:
            d = audible[0]
            return Response(
                content=d.audio,
                media_type=d.content_type or "application/octet-stream",
                headers={
                    "X-Segment": str(result.seg),
                    "X-From": result.speaker,
                    "X-To": d.to,
                    "X-Source-Text": quote(result.source_text),
                    "X-Target-Text": quote(d.text),
                    "X-Total-Ms": str(result.metrics.get("total_ms", "")),
                },
            )

        body = result.meta()
        for meta, delivery in zip(body["deliveries"], result.deliveries):
            if delivery.audio:
                meta["audio_base64"] = base64.b64encode(delivery.audio).decode("ascii")
        return JSONResponse(body)

    @app.get(
        "/v1/models",
        summary="Models the provider actually offers",
        dependencies=[auth],
    )
    async def list_models(provider: str | None = None) -> dict:
        """Asks the provider directly instead of hardcoding model names in the code or client."""
        pid = provider or state.config.get("llm.default_provider")
        try:
            return {"provider": pid, "models": await state.providers.models(pid)}
        except LLMError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post(
        "/v1/translate/text",
        summary="Text translation (without STT/TTS)",
        dependencies=[auth],
    )
    async def translate_text(req: TextTranslateRequest):
        """Use this to exercise the LLM layer alone. The speech pipeline reuses it internally."""
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

    # ---- 음성 등록 (voice print) --------------------------------------------
    #
    # ★ 여기서 만들어지는 임베딩은 생체정보에 준하는 개인정보다. 목록 응답에는
    #   절대 벡터를 싣지 않는다 (app/voiceprints.py 의 주석을 볼 것).

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
            raise HTTPException(413, f"Audio is too large ({total} > {limit} bytes)")

        minimum = int(c.get("speaker_id.min_enroll_files"))
        if len(payload) < minimum:
            raise HTTPException(
                400,
                f"Enrolling '{speaker_id}' needs at least {minimum} non-empty audio file(s), "
                f"got {len(payload)} (speaker_id.min_enroll_files)",
            )

        try:
            body = await state.speaker_engine.enroll(
                mode=mode or c.get("session.default_mode"), files=payload
            )
        except EngineError as exc:
            raise HTTPException(502, str(exc)) from exc
        except RegistryError as exc:
            raise HTTPException(500, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(502, str(exc)) from exc

        try:
            vp = state.voiceprints.put(
                speaker_id=speaker_id,
                name=name or speaker_id,
                embedding=body["embedding"],
                utterances=int(body.get("count") or len(payload)),
                dim=int(body.get("dim") or 0),
                engine=str(body.get("engine") or ""),
                model=str(body.get("model") or ""),
            )
        except VoicePrintError as exc:
            raise HTTPException(500, str(exc)) from exc

        threshold = float(c.get("speaker_id.threshold"))
        spread = body.get("min_pairwise_similarity")
        warning = None
        if spread is not None and float(spread) < threshold:
            warning = (
                f"The uploaded utterances are only {float(spread):.2f} alike, which is below "
                f"the match threshold of {threshold}. They may not all be the same person"
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
        try:
            removed = state.voiceprints.delete(speaker_id)
        except VoicePrintError as exc:
            raise HTTPException(500, str(exc)) from exc
        if not removed:
            raise HTTPException(404, f"No voice print is enrolled for '{speaker_id}'")
        return {"deleted": speaker_id, "enrolled": state.voiceprints.count()}

    # ---- 실시간 스트림 ------------------------------------------------------
    #
    # 경로도 설정에서 온다. 데코레이터가 기동 시점에 한 번 평가되므로
    # 경로를 바꾸려면 재기동이 필요하다 — 그 점만 다른 설정과 다르다.
    @app.websocket(cfg.get("stream.path"))
    async def stream(ws: WebSocket) -> None:
        """
        Audio in (PCM16 binary frames), translated audio + text out.

        Server-side VAD cuts the stream into segments, so the client does not
        have to decide when an utterance ended. See DESIGN.md for the protocol.
        """
        if not _ws_authorized(state, ws):
            # 정책상 accept 전에 거절한다. 핸드셰이크 단계에서 끊어야
            # 브라우저가 "인증 실패"를 열린 연결의 오류로 착각하지 않는다.
            await ws.close(code=int(state.config.get("stream.unauthorized_close_code")))
            return
        state.reload_if_changed()
        await StreamHandler(ws, state).run()

    @app.post("/v1/admin/reload", summary="Reload configuration", dependencies=[auth])
    async def reload_config() -> dict:
        state.config.reload()
        state.engines.load()
        state.profiles.load()
        await state.engines.probe_all()
        return {"status": "reloaded", "engines": len(state.engines.snapshot())}

    @app.post("/v1/admin/config", summary="Override runtime configuration", dependencies=[auth])
    async def patch_config(patch: dict) -> dict:
        """Applied at the highest priority. Takes effect without a restart."""
        state.config.set_runtime(patch)
        state.engines.load()
        state.profiles.load()
        return {"status": "applied", "keys": sorted(patch)}

    return app


class ContextTurn(BaseModel):
    source: str
    target: str


class TextTranslateRequest(BaseModel):
    # FastAPI 가 이 docstring 을 OpenAPI 스키마 설명으로 노출하므로 영어로 쓴다.
    """Translation direction is decided by the request. No language-pair constant in code."""

    text: str = Field(..., description="Source text to translate")
    source_lang: str = Field(..., description="Source language (e.g. ko)")
    target_lang: str = Field(..., description="Target language (e.g. en)")
    provider: str | None = Field(None, description="Defaults to llm.default_provider if omitted")
    model: str | None = Field(
        None, description="Defaults to the provider's default_model if omitted"
    )
    style: str | None = Field(None, description="A key of prompts.styles")
    context: list[ContextTurn] | None = Field(None, description="Preceding conversation turns")
    glossary: dict[str, str] | None = Field(
        None, description="Glossary (source term → translated term)"
    )
    stream: bool = False


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
            raise HTTPException(401, "Invalid API key")

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
