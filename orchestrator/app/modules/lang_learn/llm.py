"""
문제 생성·평가·총평을 위한 LLM 호출부.

`core/llm.py` 의 `Translator` 는 번역 전용(항상 "원문 → 번역문" 한 가지 질문만
한다)이라 그대로 재사용할 수 없다. 여기서는 `ctx.providers.get(...).chat()` 을
직접 쓴다 — 어댑터 계층은 그대로 재사용하고, "무엇을 물어볼지"만 이 모듈이
새로 정한다(moduleapi.py 의 설계 원칙과 같다: 어댑터는 프로토콜, 호출부는 흐름).

세 호출(문제 생성/평가/총평) 모두 시스템 프롬프트만으로 지시를 완성해 두고
(`prompts.lang_learn.*`, 이미 값이 채워진 문자열), 사용자 메시지는 자리표시자
하나만 보낸다 — 대화형 채팅이 아니라 구조화된 요청-응답이라 그렇다.

**응답은 JSON 하나만 받는다.** LLM 이 설명을 앞뒤에 붙이는 경우를 위해 문자열
전체에서 첫 `{` 부터 마지막 `}` 까지를 다시 파싱해보는 관용도를 하나 둔다.
그래도 실패하면 그대로 죽는다(`lang_learn.llm_response_invalid`) — 조용히
기본값(빈 문제, 점수 0)으로 넘어가면 사용자가 이유를 모른 채 이상한 세션을
겪는다. 명시적 실패가 낫다는 것은 이 프로젝트의 기존 원칙(core/errors.py)과
같다.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ...core.errors import AppError

log = logging.getLogger("lang_learn.llm")


class LangLearnLLMError(AppError):
    default_code = "lang_learn.failed"
    default_status = 502


async def _chat(ctx: Any, *, system: str) -> str:
    provider = ctx.config.get_optional("lang_learn.llm.provider")
    model = ctx.config.get_optional("lang_learn.llm.model")
    adapter = ctx.providers.get(provider)
    chunks: list[str] = []
    async for piece in adapter.chat(
        model=model,
        system=system,
        messages=[{"role": "user", "content": "Respond now, with only the JSON object."}],
        stream=False,
    ):
        chunks.append(piece)
    return "".join(chunks).strip()


def _extract_json(text: str) -> dict:
    try:
        return json.loads(text)
    except ValueError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except ValueError:
            pass
    raise LangLearnLLMError("lang_learn.llm_response_invalid", raw=text[:300])


async def ask_json(ctx: Any, *, system: str) -> dict:
    """시스템 프롬프트 하나를 보내고 JSON 객체 하나를 받는다."""
    text = await _chat(ctx, system=system)
    body = _extract_json(text)
    if not isinstance(body, dict):
        raise LangLearnLLMError("lang_learn.llm_response_invalid", raw=text[:300])
    return body


async def generate_problem(
    ctx: Any, *, target_lang: str, learner_lang: str, level: str, answer_type: str,
    recent_topics: list[str],
) -> str:
    system = ctx.config.get("prompts.lang_learn.problem_system").format(
        target_lang=target_lang,
        learner_lang=learner_lang,
        level=level,
        answer_type=answer_type,
        recent_topics=", ".join(recent_topics) or "(none yet)",
    )
    body = await ask_json(ctx, system=system)
    text = str(body.get("text") or "").strip()
    if not text:
        raise LangLearnLLMError("lang_learn.llm_response_invalid", raw=json.dumps(body)[:300])
    return text


async def evaluate_answer(
    ctx: Any, *, target_lang: str, learner_lang: str, level: str, answer_type: str,
    problem_text: str, answer_text: str,
) -> tuple[int, str]:
    system = ctx.config.get("prompts.lang_learn.evaluate_system").format(
        target_lang=target_lang,
        learner_lang=learner_lang,
        level=level,
        answer_type=answer_type,
        problem_text=problem_text,
        answer_text=answer_text or "(no answer)",
    )
    body = await ask_json(ctx, system=system)
    score = max(0, min(100, int(body.get("score", 0))))
    comment = str(body.get("comment") or "").strip()
    return score, comment


async def summarize_session(
    ctx: Any, *, target_lang: str, learner_lang: str, level: str, transcript: str,
) -> tuple[int, str]:
    system = ctx.config.get("prompts.lang_learn.summary_system").format(
        target_lang=target_lang, learner_lang=learner_lang, level=level, transcript=transcript,
    )
    body = await ask_json(ctx, system=system)
    score = max(0, min(100, int(body.get("score", 0))))
    comment = str(body.get("comment") or "").strip()
    return score, comment
