"""
문장 은행 조회 헬퍼 — `config/defaults.yaml` 의 `stt_training.sentence_bank` 를 읽는다.

문장 자체는 설정에만 있다(하드코딩 금지 원칙). 여기 있는 것은 그 구조를 다루는
작은 헬퍼뿐이다 — `next_prompt`(routes.py)와 `read_sample` 업로드 검증이 같은
조회 로직을 두 번 쓰지 않게 하기 위해서다.
"""

from __future__ import annotations

from ...core.config import Config
from ...core.errors import AppError


class SentenceBankError(AppError):
    default_code = "stt_training.failed"
    default_status = 500


def languages(cfg: Config) -> list[str]:
    """문장 은행이 있는 언어 목록."""
    return sorted(cfg.require_section("stt_training.sentence_bank").keys())


def sentences_for(cfg: Config, lang: str) -> list[dict]:
    """`lang` 의 문장 목록(`{id, text}`). 없는 언어면 400."""
    bank = cfg.require_section("stt_training.sentence_bank")
    items = bank.get(lang)
    if not items:
        raise SentenceBankError(
            "stt_training.unknown_lang", status=400, lang=lang, available=", ".join(sorted(bank))
        )
    return items


def find_prompt(cfg: Config, prompt_id: str) -> tuple[str, str]:
    """`prompt_id` 를 전체 언어에서 찾는다. `(lang, text)` 를 돌려준다. 없으면 400.

    id 는 언어를 가리지 않고 전체에서 고유하다는 전제다(설정 주석 참고) — 그래야
    `read_sample` 업로드가 `lang` 을 별도로 받지 않고도 어느 문장인지 알 수 있다.
    """
    bank = cfg.require_section("stt_training.sentence_bank")
    for lang, items in bank.items():
        for item in items:
            if str(item.get("id")) == prompt_id:
                return lang, str(item.get("text") or "")
    raise SentenceBankError("stt_training.unknown_prompt", status=400, prompt_id=prompt_id)
