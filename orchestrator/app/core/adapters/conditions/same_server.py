"""
엔드포인트 조건: same_server.

engines.yaml 에서 이렇게 쓴다.

    endpoints:
      - url: http://voice-whisper:8101
        when: { same_server: true }      # 오케스트레이터와 같은 서버일 때만
        priority: 10
      - url: https://stt.whisper.example
        priority: 20                     # 조건 없음 = 항상 후보

같은 서버면 프록시 홉과 TLS 핸드셰이크가 빠져 실시간 지연 예산에 도움이 된다.
"내부 주소"라는 개념을 코드가 알 필요 없이, 조건과 우선순위만으로 표현된다.

새 조건을 추가하려면 이 폴더에 파일 하나를 더 넣으면 된다. 기존 파일은 건드리지 않는다.
"""

from __future__ import annotations

from typing import Any

from ...engines import CONDITION_KIND
from ...registry import register


@register(CONDITION_KIND, "same_server")
def same_server(expected: Any, context: dict[str, Any]) -> bool:
    """엔진의 server 값과 오케스트레이터의 server.id 가 같은지."""
    # expected 가 true 면 "같아야 한다", false 면 "달라야 한다"
    engine_server = context.get("engine_server")
    same = bool(engine_server) and engine_server == context.get("server_id")
    return same if bool(expected) else not same
