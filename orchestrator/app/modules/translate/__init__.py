"""
음성 번역 모듈 — 화자 식별 → STT → 번역 → TTS.

    pipeline.py   흐름 (원문 확정 → 수신자별 fan-out)
    streaming.py  WebSocket 세션 (VAD 로 잘라 세그먼트마다 흐름을 돌린다)
    routes.py     HTTP·WS 입구

이 폴더는 core 만 안다. server.py 도, 다른 모듈도 알지 못한다 — 그래야 폴더째
옮겨 붙일 수 있다. 계약은 `app/core/moduleapi.py` 를 볼 것.
"""

from __future__ import annotations

from ...core.moduleapi import Module, ModuleContext, module


@module("translate")
class TranslateModule(Module):
    def __init__(self, ctx: ModuleContext):
        super().__init__(ctx)
        from .pipeline import Pipeline

        # 흐름은 모듈이 갖는다. 단계(STT·TTS·화자 식별)는 ctx.speech 에서 온다.
        self.pipeline = Pipeline(ctx.speech, ctx.translator)

    def routes(self):
        from .routes import build

        return build(self.ctx, self.pipeline)

    def config_view(self, locale: str | None) -> dict:
        """
        `/v1/config` 에 실을 섹션.

        WebSocket 스트리밍은 이 모듈의 것이므로 그 규격도 이 모듈이 낸다.
        클라이언트는 이 값들로 마이크 캡처 규격을 맞춘다.

        VAD·턴 정책·배경 음성 게이트는 core 가 낸다 — 앞으로 붙을 음성 대화·학습
        모듈도 같은 것을 쓰기 때문이다.
        """
        c = self.ctx.config
        return {
            "stream": {
                "path": c.get("stream.path"),
                "input_format": c.get("stream.input_format"),
                "client_frame_ms": c.get("stream.client_frame_ms"),
            },
        }
