"""
상류(엔진·LLM 프로바이더)가 돌려준 실패를 어떻게 다룰 것인가 — 규칙을 한 곳에 둔다.

상류 응답 본문에는 우리 것이 아닌 정보가 섞여 있다. 실제로 이런 것이 들어 있었다.

    {"error":{"message":"Request too large for model `llama-3.3-70b-versatile`
      in organization `org_01k...` service tier `on_demand` on tokens per minute
      (TPM): Limit 12000, ..."}}

조직 식별자·모델명·요금제·레이트리밋 한도가 API 를 부르는 누구에게나 나간다. 그래서
**본문은 기본적으로 클라이언트에 보이지 않는다.** 클라이언트가 받는 것은 어느 상류가
어떤 상태로 실패했는가까지다.

**본문은 설정과 무관하게 언제나 서버 로그에 남는다.** 상류가 무엇이라고 했는지 모르면
고칠 수 없고, 로그는 운영자만 본다. 잃는 것 없이 새는 것만 막는 것이 요점이다.

보이게 하려면 `diagnostics.expose_upstream_errors: true`. 문제를 재현하는 동안만 켠다.

코드는 두 벌이다. 문장 끝에 콜론만 덩그러니 남지 않게, 본문이 실릴 때는 다른 코드를 쓴다.

    engine.stt_failed          "STT error 500"
    engine.stt_failed_detail   "STT error 500: {body}"
"""

from __future__ import annotations

import logging
from typing import Any, Type

from .errors import AppError

log = logging.getLogger("upstream")

# 본문을 실은 코드는 같은 코드 뒤에 이것이 붙는다. 카탈로그에 두 키가 모두 있어야 한다
# (검증은 orchestrator/tools/check_messages.py 가 한다).
DETAIL_SUFFIX = "_detail"


def failure(
    error_cls: Type[AppError],
    code: str,
    *,
    body: Any,
    expose: bool,
    **params: Any,
) -> AppError:
    """
    상류 실패를 던질 수 있는 예외로. 본문은 로그로 가고, 노출은 설정이 정한다.

        raise upstream.failure(
            EngineError, "engine.stt_failed",
            body=r.text[:300], expose=self._expose, status_code=r.status_code,
        )

    `params` 에 `body` 를 남기지 않는 것이 요점이다. 문장에서만 빼고 파라미터에
    남기면 아무것도 막지 못한다.
    """
    text = str(body or "").strip()
    log.warning("upstream failure [%s] %s :: %s", code, params, text or "-")
    if expose and text:
        return error_cls(code + DETAIL_SUFFIX, **params, body=text)
    return error_cls(code, **params)
