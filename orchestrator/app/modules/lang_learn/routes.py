"""
`lang_learn` 모듈의 HTTP·WebSocket 입구.

    GET  /v1/users/{user_id}/lang_learn/settings   학습 설정 조회 (없으면 기본값)
    PUT  /v1/users/{user_id}/lang_learn/settings   학습 설정 갱신 (부분 갱신)
    GET  /v1/users/{user_id}/lang_learn/history    과거 학습 세션 이력 조회 (최신순)
    WS   {lang_learn.stream.path}                  학습 세션

인증은 이 모듈이 정하지 않는다 — `translate` 모듈과 같은 규칙(`ctx.auth`,
`ctx.ws_authorized()`)을 그대로 따른다.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket
from pydantic import BaseModel

from ...core.moduleapi import ModuleContext
from .history_store import LangLearnHistoryStore
from .session import LangLearnSession
from .settings_store import LangLearnSettingsStore

log = logging.getLogger("lang_learn")


class LangLearnSettingsPatch(BaseModel):
    """
    PUT 요청 본문. 전부 선택 필드다 — **부분 갱신**을 허용한다(준 필드만 바뀐다).

    전체 교체를 요구하면 클라이언트가 스케줄만 바꾸고 싶을 때도 항상 먼저 GET
    으로 나머지 필드를 읽어와야 한다. `exclude_unset=True` 로 요청 본문에 실제로
    있던 키만 골라내므로, `manual_level: null` 처럼 명시적으로 지우는 것과
    필드를 아예 안 보내는 것(그대로 둔다)을 구분할 수 있다.
    """

    schedule: list[dict] | None = None
    target_lang: str | None = None
    level_mode: str | None = None
    manual_level: str | None = None
    feedback_mode: str | None = None
    show_text_for_repeat: bool | None = None


def build(
    ctx: ModuleContext,
    settings: LangLearnSettingsStore,
    history: LangLearnHistoryStore,
) -> APIRouter:
    router = APIRouter()
    auth = ctx.auth

    @router.get(
        "/v1/users/{user_id}/lang_learn/settings",
        summary="Get a user's language-learning settings (defaults if never set)",
        dependencies=[auth],
    )
    async def get_settings(user_id: str) -> dict:
        ctx.reload_if_changed()
        return settings.get(user_id)

    @router.put(
        "/v1/users/{user_id}/lang_learn/settings",
        summary="Update a user's language-learning settings (partial update)",
        dependencies=[auth],
    )
    async def put_settings(user_id: str, patch: LangLearnSettingsPatch) -> dict:
        ctx.reload_if_changed()
        return settings.update(user_id, patch.model_dump(exclude_unset=True))

    @router.get(
        "/v1/users/{user_id}/lang_learn/history",
        summary="List a user's past language-learning sessions (most recent first)",
        dependencies=[auth],
    )
    async def get_history(user_id: str) -> dict:
        """No matching sessions is not an error — this returns an empty list."""
        ctx.reload_if_changed()
        sessions = history.list(user_id=user_id)
        sessions_public = [s.public() for s in reversed(sessions)]
        return {"user_id": user_id, "count": len(sessions_public), "sessions": sessions_public}

    @router.websocket(ctx.config.get("lang_learn.stream.path"))
    async def stream(ws: WebSocket) -> None:
        """
        학습 세션. 첫 메시지는 `{"type":"start","user_id":...,"count":...}` 여야
        한다 (인증은 핸드셰이크 단계에서 이미 끝났다). 프로토콜은
        DESIGN.md §15 와 이 모듈의 README 격인 `session.py` 상단 주석을 볼 것.
        """
        if not ctx.ws_authorized(ws):
            await ws.close(code=int(ctx.config.get("lang_learn.stream.unauthorized_close_code")))
            return
        ctx.reload_if_changed()
        await LangLearnSession(ws, ctx, settings, history).run()

    return router
