"""
다국어 처리.

이 프로그램은 특정 언어에 묶이지 않는다. 두 축이 있다.

  1. **번역 언어** (source_lang / target_lang) — 세션이 정한다. 코드에 언어쌍 상수가 없다.
  2. **표시 언어** (locale) — 화면에 보이는 문구의 언어. 클라이언트가 정한다.

설정 파일의 사람이 읽는 문구(label, description 등)는 문자열 하나로 써도 되고
로케일 맵으로 써도 된다.

    label: "One-way"                       # 모든 로케일에서 이 값
    label:                                 # 로케일별
      en: "One-way"
      ko: "단방향"

**기본어는 영어다.** 요청한 로케일이 없으면 en 으로 떨어지고, en 도 없으면 아무거나 하나.
코드가 만들어내는 문구(오류 메시지 등)도 영어로 쓴다.
"""

from __future__ import annotations

from typing import Any

# 로케일을 못 찾았을 때 떨어질 곳. 한국어가 아니라 영어다.
FALLBACK_LOCALE = "en"


def normalize(locale: str | None) -> str:
    """'ko-KR', 'en_US;q=0.9' 같은 것을 'ko', 'en' 으로."""
    if not locale:
        return FALLBACK_LOCALE
    head = locale.split(",")[0].split(";")[0].strip()
    return head.replace("_", "-").split("-")[0].lower() or FALLBACK_LOCALE


def localize(value: Any, locale: str | None) -> Any:
    """
    로케일 맵이면 해당 언어를, 아니면 값을 그대로.

    맵인지 판단은 "모든 키가 짧은 문자열이고 값이 문자열"인지로 하지 않는다.
    그건 오탐이 난다. 대신 FALLBACK_LOCALE 키가 있으면 로케일 맵으로 본다.
    """
    if not isinstance(value, dict) or FALLBACK_LOCALE not in value:
        return value
    want = normalize(locale)
    if want in value:
        return value[want]
    return value[FALLBACK_LOCALE]


def localize_all(node: Any, locale: str | None) -> Any:
    """중첩 구조 전체에 localize 를 적용한다."""
    if isinstance(node, dict):
        if FALLBACK_LOCALE in node and all(isinstance(v, str) for v in node.values()):
            return localize(node, locale)
        return {k: localize_all(v, locale) for k, v in node.items()}
    if isinstance(node, list):
        return [localize_all(v, locale) for v in node]
    return node
