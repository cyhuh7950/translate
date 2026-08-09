"""
번역 모듈의 HTTP·WebSocket 입구.

    POST /v1/translate/audio     오디오 → 번역 오디오 (배치/PTT)
    POST /v1/translate/text      텍스트 → 번역 텍스트 (+선택적으로 번역 오디오)
    WS   {stream.path}           실시간 스트리밍

공용 라우트(`/health`, `/v1/config`, `/v1/speakers/*`, `/v1/admin/*`)는 여기 없다.
그것들은 어느 기능이든 쓰므로 core 가 갖는다 — 음성 등록도 마찬가지다.

인증은 이 모듈이 정하지 않는다. `ctx.auth` 를 라우트에 걸고, WebSocket 은
`ctx.ws_authorized()` 를 부른다. 규칙이 모듈마다 갈리지 않게 하기 위해서다.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from urllib.parse import quote

from fastapi import APIRouter, File, Form, Response, UploadFile, WebSocket
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from ...core import preprocess
from ...core.config import Config
from ...core.errors import AppError
from ...core.llm import Turn
from ...core.moduleapi import ModuleContext
from .pipeline import Pipeline
from .streaming import StreamHandler

log = logging.getLogger("translate")


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

    # --- 번역문을 소리로도 받을 때 (기기 STT + 서버 TTS) ---
    #
    # 기본값이 False 인 것은 이 엔드포인트의 원래 계약이 "텍스트만"이기 때문이다.
    # 켜면 세션·참여자 모델을 지나므로 응답이 /v1/translate/audio 와 같은 모양이 된다.
    with_audio: bool = Field(
        False,
        description=(
            "Also synthesize the translation. The response then looks like "
            "/v1/translate/audio (deliveries with from/to). Cannot be used with stream"
        ),
    )
    profile: str | None = Field(None, description="Session profile. Defaults if omitted")
    mode: str | None = Field(None, description="Session mode used to route the engines")
    speaker: str | None = Field(None, description="Participant id of the speaker")
    tts_engine: str | None = Field(None, description="Defaults to the routing policy's choice")
    voice: str | None = Field(None, description="Defaults to the engine's own default voice")
    speed: float | None = Field(None, description="Defaults to audio.tts_speed")
    response_format: str | None = Field(None, description="Defaults to audio.tts_response_format")
    response_mode: str | None = Field(None, description="json | binary")


def _segment_response(cfg: Config, result, response_mode: str | None):
    """
    세그먼트 결과를 HTTP 응답으로. 오디오·텍스트 두 입구가 같은 규칙으로 답한다.

    두 엔드포인트가 응답 모양을 따로 정하면 클라이언트가 입구마다 다른 파서를
    갖게 된다. 규칙은 한 곳에만 둔다.
    """
    wants = response_mode or cfg.get("audio.response_mode")
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


def build(ctx: ModuleContext, pipeline: Pipeline) -> APIRouter:
    """이 모듈의 라우터를 만든다. 경로도 인증도 전부 여기서 닫힌다."""
    router = APIRouter()
    auth = ctx.auth

    @router.post(
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
        ctx.reload_if_changed()
        c = ctx.config

        # 세션·엔진·LLM·레지스트리 오류는 전부 코드와 HTTP 상태를 들고 있다.
        # 여기서 다시 상태를 정하지 않고 server.py 의 봉투 핸들러로 올린다.
        session = ctx.profiles.create(
            profile=profile, mode=mode, source_lang=source_lang, target_lang=target_lang
        )

        audio = await file.read()
        if not audio:
            raise AppError("audio.empty", status=400)
        limit = int(c.get("server.max_upload_bytes"))
        if len(audio) > limit:
            raise AppError("audio.too_large", status=413, size=len(audio), limit=limit)

        # 배경 음성 게이트. 옆에서 TV 가 나오는 환경에서 사용자가 말을 쉬는 구간이
        # STT 로 넘어가 그대로 받아적히는 것을 막는다. 핸즈프리(WS)도 같은 구현을 쓴다.
        # 꺼져 있으면 바이트가 손대지 않은 채 그대로 지나간다.
        audio, filename, content_type, gate_metrics = await preprocess.filter_upload(
            c,
            audio,
            file.filename or c.get("audio.pcm_filename"),
            file.content_type or "application/octet-stream",
        )

        result = await pipeline.run_audio(
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

        # 게이트가 얼마나 잘라냈는지는 응답의 metrics 로 나간다. 튜닝의 근거다.
        result.metrics.update(gate_metrics)

        return _segment_response(c, result, response_mode)

    @router.post(
        "/v1/translate/text",
        summary="Text translation (without STT/TTS)",
        dependencies=[auth],
    )
    async def translate_text(req: TextTranslateRequest):
        """
        Text in, translated text out — and translated speech too when `with_audio` is set.

        Without `with_audio` this exercises the LLM layer alone and returns just the
        translation. With it, the request goes through the session and participant
        model exactly like `/v1/translate/audio` does, so the answer carries `from`
        and `to` and can be spoken. That is the path for a client that runs speech
        recognition on the device and wants the server to do the speaking.
        """
        ctx.reload_if_changed()
        c = ctx.config
        context = [Turn(source=t.source, target=t.target) for t in (req.context or [])]

        if req.with_audio:
            # 스트리밍 응답은 토큰을 그대로 흘려보내는 본문이라 오디오를 실을 자리가 없다.
            # 번역이 끝난 뒤에 합성하면 클라이언트는 이미 본문을 다 받은 뒤다. 조용히
            # 한쪽을 무시하는 대신 요청을 거절한다 — 소리를 내며 흘려보내는 경로는 WS 다.
            if req.stream:
                raise AppError(
                    "request.stream_with_audio", status=400, path=c.get("stream.path")
                )
            session = ctx.profiles.create(
                profile=req.profile,
                mode=req.mode,
                source_lang=req.source_lang,
                target_lang=req.target_lang,
            )

            # 합성까지 하는 경로에만 길이 상한을 건다. 오디오 업로드에 상한이 있는 것과
            # 같은 이유(TTS 엔진을 붙잡는 시간)이고, 기존 텍스트 전용 경로의 동작은
            # 건드리지 않기 위해서다.
            limit = int(c.get("limits.max_input_chars"))
            if len(req.text) > limit:
                raise AppError(
                    "text.too_long", status=413, length=len(req.text), limit=limit
                )

            result = await pipeline.run_text(
                session,
                text=req.text,
                speaker_hint=req.speaker,
                tts_engine=req.tts_engine,
                voice=req.voice,
                speed=float(req.speed if req.speed is not None else c.get("audio.tts_speed")),
                response_format=req.response_format or c.get("audio.tts_response_format"),
                provider=req.provider,
                model=req.model,
                style=req.style,
                context=context,
                glossary=req.glossary,
                with_audio=True,
            )
            return _segment_response(c, result, req.response_mode)

        kwargs = dict(
            source_lang=req.source_lang,
            target_lang=req.target_lang,
            provider=req.provider,
            model=req.model,
            style=req.style,
            context=context,
            glossary=req.glossary,
        )
        if req.stream:
            async def gen():
                async for piece in ctx.translator.stream(req.text, **kwargs):
                    yield piece
            return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")

        started = asyncio.get_running_loop().time()
        text = await ctx.translator.translate(req.text, **kwargs)
        elapsed = asyncio.get_running_loop().time() - started
        return {
            "text": text,
            "source_lang": req.source_lang,
            "target_lang": req.target_lang,
            "provider": req.provider or ctx.config.get("llm.default_provider"),
            "model": req.model,
            "elapsed_s": round(elapsed, 3),
        }

    # ---- 실시간 스트림 ------------------------------------------------------
    #
    # 경로도 설정에서 온다. 데코레이터가 기동 시점에 한 번 평가되므로
    # 경로를 바꾸려면 재기동이 필요하다 — 그 점만 다른 설정과 다르다.
    @router.websocket(ctx.config.get("stream.path"))
    async def stream(ws: WebSocket) -> None:
        """
        Audio in (PCM16 binary frames), translated audio + text out.

        Server-side VAD cuts the stream into segments, so the client does not
        have to decide when an utterance ended. See DESIGN.md for the protocol.
        """
        if not ctx.ws_authorized(ws):
            # 정책상 accept 전에 거절한다. 핸드셰이크 단계에서 끊어야
            # 브라우저가 "인증 실패"를 열린 연결의 오류로 착각하지 않는다.
            await ws.close(code=int(ctx.config.get("stream.unauthorized_close_code")))
            return
        ctx.reload_if_changed()
        await StreamHandler(ws, ctx, pipeline).run()

    return router
