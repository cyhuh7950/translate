"""
외국어 학습 모듈 — 스케줄 → TTS → STT → 평가 → TTS.

    settings_store.py   사용자별 학습 설정 (schedule·level·feedback_mode …)
    history_store.py    세션 이력 (문제·답변·평가·총평)
    llm.py               문제 생성/평가/총평을 위한 LLM 호출부
    session.py           WebSocket 세션 하나의 수명 (흐름 그 자체)
    routes.py             HTTP·WS 입구

이 폴더는 core 만 안다 — `ctx.speech`(STT/TTS), `ctx.providers`(LLM),
`ctx.users`(사용자 존재 확인), `ctx.voice_samples`(STT 개인화 배선). 설정·이력
저장소는 이 모듈 전용 개념이라 core 로 올리지 않고 여기 둔다(각 파일 상단 주석에
근거가 있다). 계약은 `app/core/moduleapi.py` 를 볼 것.
"""

from __future__ import annotations

from ...core.moduleapi import Module, ModuleContext, module


@module("lang_learn")
class LangLearnModule(Module):
    def __init__(self, ctx: ModuleContext):
        super().__init__(ctx)
        from .history_store import LangLearnHistoryStore
        from .settings_store import LangLearnSettingsStore

        self.settings = LangLearnSettingsStore(ctx.config)
        self.history = LangLearnHistoryStore(ctx.config)

    def routes(self):
        from .routes import build

        return build(self.ctx, self.settings, self.history)

    def config_view(self, locale: str | None) -> dict:
        """
        `/v1/config` 에 실을 섹션. WebSocket 경로도 여기서 낸다 — `translate`
        모듈이 `stream.path` 를 얹는 것과 같은 이유(클라이언트가 경로를
        하드코딩하지 않게).
        """
        c = self.ctx.config
        return {
            "lang_learn": {
                "stream": {
                    "path": c.get("lang_learn.stream.path"),
                    "default_count": c.get("lang_learn.stream.default_count"),
                },
                "levels": c.get("lang_learn.levels"),
                "defaults": c.get("lang_learn.defaults"),
                "answer_type_pattern": c.get("lang_learn.answer_type_pattern"),
            },
        }
