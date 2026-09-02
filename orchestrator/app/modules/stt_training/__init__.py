"""
STT 개인화 데이터 수집 모듈 — 낭독 교정 + 정오 판정.

DESIGN.md §16 "0단계"(PLAN_STT_PERSONALIZATION.md 의 0-S1~0-S7)의 서버 쪽 전부다.
이 모듈이 하는 일은 **데이터 수집까지만**이다 — 모은 (음성, 정답텍스트) 쌍을
방법 B(LLM 문맥 개인화)나 방법 A(파인튜닝)가 어떻게 쓸지는 이 모듈이 모른다.

    bank.py           설정(`stt_training.sentence_bank`)에서 문장을 찾는 헬퍼
    read_store.py     낭독 교정 저장소 (문장+음성 확정쌍)
    verify_store.py   정오 판정 저장소 (음성+STT결과+판정[+교정텍스트], pending→확정)
    routes.py         HTTP 입구

이 폴더는 core 만 안다 — `ctx.speech`(STT), `ctx.users`(사용자 존재 확인). 저장소
둘은 이 모듈 전용 개념이라(다른 모듈이 참조할 이유가 아직 없다) core 로 올리지
않고 여기 둔다 — `lang_learn/settings_store.py` 상단 주석과 같은 판단이다.
"""

from __future__ import annotations

from ...core.moduleapi import Module, ModuleContext, module


@module("stt_training")
class SttTrainingModule(Module):
    def __init__(self, ctx: ModuleContext):
        super().__init__(ctx)
        from .read_store import ReadSampleStore
        from .verify_store import VerifySampleStore

        self.read_store = ReadSampleStore(ctx.config)
        self.verify_store = VerifySampleStore(ctx.config)

    def routes(self):
        from .routes import build

        return build(self.ctx, self.read_store, self.verify_store)

    def config_view(self, locale: str | None) -> dict:
        """
        `/v1/config` 에 실을 섹션 — 앱이 UI 를 그리는 데 필요한 것만. 문장 은행의
        '내용'(실제 문장 목록)은 여기 내보내지 않는다 — `next_prompt` 가 한 번에
        하나씩만 주는 것이 의도다(전부 미리 보여주면 "아직 안 읽은 문장" 흐름이
        의미가 없어진다). 앱은 이 목록으로 언어 선택 UI 와 목표 개수 표시만 그린다.
        """
        c = self.ctx.config
        return {
            "stt_training": {
                "languages": sorted(c.get("stt_training.sentence_bank").keys()),
                "default_lang": c.get("stt_training.default_lang"),
                "required_read_count": c.get("stt_training.required_read_count"),
                "required_verify_count": c.get("stt_training.required_verify_count"),
            },
        }
