"""
`stt_training` 모듈의 HTTP 입구 — 전부 요청-응답으로 충분하다(WS 아님, DESIGN.md
§16). 서버가 오디오를 합성해서 들려줄 필요가 없는 흐름이라서다.

    GET  /v1/users/{user_id}/stt_training/next_prompt         낭독 교정 — 다음 문장
    POST /v1/users/{user_id}/stt_training/read_sample         낭독 교정 — 업로드
    POST /v1/users/{user_id}/stt_training/verify              정오 판정 — STT 실행
    POST /v1/users/{user_id}/stt_training/verify/{id}/verdict 정오 판정 — 확정
    GET  /v1/users/{user_id}/stt_training/status               진행 상황

인증은 이 모듈이 정하지 않는다 — `lang_learn`/`translate` 와 같은 규칙(`ctx.auth`).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, File, Form, Query, UploadFile
from pydantic import BaseModel

from ...core.config import Config
from ...core.errors import AppError
from ...core.moduleapi import ModuleContext
from . import bank
from .read_store import ReadSampleStore
from .verify_store import VerifySampleStore

log = logging.getLogger("stt_training")


class VerdictRequest(BaseModel):
    correct: bool
    corrected_text: str | None = None


def _require_user(ctx: ModuleContext, user_id: str) -> None:
    if ctx.users.get(user_id) is None:
        raise AppError("stt_training.unknown_user", status=404, user_id=user_id)


def _read_progress(cfg: Config, read_store: ReadSampleStore, user_id: str) -> dict:
    required = int(cfg.get("stt_training.required_read_count"))
    return {"done": min(read_store.progress(user_id=user_id), required), "required": required}


def _verify_progress(cfg: Config, verify_store: VerifySampleStore, user_id: str) -> dict:
    required = int(cfg.get("stt_training.required_verify_count"))
    return {"done": min(verify_store.progress(user_id=user_id), required), "required": required}


def build(
    ctx: ModuleContext,
    read_store: ReadSampleStore,
    verify_store: VerifySampleStore,
) -> APIRouter:
    router = APIRouter()
    auth = ctx.auth
    cfg = ctx.config

    # ---- 낭독 교정 ----------------------------------------------------------

    @router.get(
        "/v1/users/{user_id}/stt_training/next_prompt",
        summary="Read-aloud correction: the next sentence to read (or 'done')",
        dependencies=[auth],
    )
    async def next_prompt(
        user_id: str,
        lang: str | None = Query(None, description="Defaults to stt_training.default_lang"),
    ) -> dict:
        ctx.reload_if_changed()
        _require_user(ctx, user_id)
        want_lang = lang or cfg.get("stt_training.default_lang")
        progress = _read_progress(cfg, read_store, user_id)

        if progress["done"] >= progress["required"]:
            return {"done": True, "progress": progress}

        done_ids = read_store.done_prompt_ids(user_id=user_id)
        sentences = bank.sentences_for(cfg, want_lang)
        for item in sentences:
            if str(item["id"]) not in done_ids:
                return {
                    "done": False,
                    "prompt": {"id": item["id"], "lang": want_lang, "text": item["text"]},
                    "progress": progress,
                }
        # 이 언어의 문장 은행을 이미 다 읽었지만 목표 개수(required)에는
        # 못 미친 경우(은행이 목표보다 작게 설정된 경우) — 다른 언어로 계속하거나
        # 문장 은행을 늘려야 한다는 신호다. 에러가 아니라 '다 했다'로 답한다.
        return {"done": True, "progress": progress}

    @router.post(
        "/v1/users/{user_id}/stt_training/read_sample",
        summary="Read-aloud correction: upload the recording of a sentence",
        dependencies=[auth],
    )
    async def read_sample(
        user_id: str,
        prompt_id: str = Form(..., description="id from next_prompt"),
        file: UploadFile = File(..., description="Recording of the sentence being read"),
    ) -> dict:
        ctx.reload_if_changed()
        _require_user(ctx, user_id)
        lang, text = bank.find_prompt(cfg, prompt_id)

        audio = await file.read()
        if not audio:
            raise AppError("audio.empty", status=400)
        limit = int(cfg.get("server.max_upload_bytes"))
        if len(audio) > limit:
            raise AppError("audio.too_large", status=413, size=len(audio), limit=limit)

        read_store.save(
            user_id=user_id,
            prompt_id=prompt_id,
            lang=lang,
            text=text,
            audio=audio,
            content_type=file.content_type or "application/octet-stream",
        )
        return {"saved": True, "progress": _read_progress(cfg, read_store, user_id)}

    # ---- 정오 판정 ----------------------------------------------------------

    @router.post(
        "/v1/users/{user_id}/stt_training/verify",
        summary="Verify: run STT on a free-form recording and stage it for a verdict",
        dependencies=[auth],
    )
    async def verify(
        user_id: str,
        file: UploadFile = File(..., description="Free-form recording"),
    ) -> dict:
        ctx.reload_if_changed()
        _require_user(ctx, user_id)

        audio = await file.read()
        if not audio:
            raise AppError("audio.empty", status=400)
        limit = int(cfg.get("server.max_upload_bytes"))
        if len(audio) > limit:
            raise AppError("audio.too_large", status=413, size=len(audio), limit=limit)

        transcript = await ctx.speech.to_text(
            mode=cfg.get("stt_training.stt_mode"),
            audio=audio,
            filename=file.filename or "sample.wav",
            content_type=file.content_type or "application/octet-stream",
        )

        sample = verify_store.create_pending(
            user_id=user_id,
            audio=audio,
            content_type=file.content_type or "application/octet-stream",
            recognized_text=transcript.text,
            stt_engine=transcript.engine,
        )
        return {"sample_id": sample.id, "recognized_text": sample.recognized_text}

    @router.post(
        "/v1/users/{user_id}/stt_training/verify/{sample_id}/verdict",
        summary="Verify: confirm whether the recognized text was correct",
        dependencies=[auth],
    )
    async def verdict(user_id: str, sample_id: str, body: VerdictRequest) -> dict:
        """
        `correct: false` requires a non-empty `corrected_text` — without an answer,
        there's nothing to learn from a "wrong" verdict, so it's rejected (400).
        """
        ctx.reload_if_changed()
        _require_user(ctx, user_id)

        verify_store.confirm(
            sample_id=sample_id,
            user_id=user_id,
            correct=body.correct,
            corrected_text=body.corrected_text,
        )
        return {"confirmed": True, "progress": _verify_progress(cfg, verify_store, user_id)}

    # ---- 진행 상황 ------------------------------------------------------------

    @router.get(
        "/v1/users/{user_id}/stt_training/status",
        summary="Progress on both the read-aloud and verify goals",
        dependencies=[auth],
    )
    async def status(user_id: str) -> dict:
        ctx.reload_if_changed()
        _require_user(ctx, user_id)
        return {
            "read": _read_progress(cfg, read_store, user_id),
            "verify": _verify_progress(cfg, verify_store, user_id),
        }

    return router
