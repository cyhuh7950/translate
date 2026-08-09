"""
오류의 공통 기반 — 코드와 파라미터만 든다.

`AppError` 는 **문구를 갖지 않는다.** 코드(`<영역>.<사유>`)와 치환 파라미터,
그리고 HTTP 응답으로 옮길 때 쓸 상태 힌트만 갖는다. 문장은 요청 로케일이 정해지는
가장 바깥(HTTP 예외 핸들러, WS 오류 이벤트)에서 카탈로그로부터 만들어진다.

    raise EngineError("engine.unreachable", engine_id=eid, reason=str(exc))
    raise AppError("auth.invalid_key", status=401)

`status` 는 예약된 키워드다. 클래스마다 기본값이 있고(`default_status`), 같은 예외
종류라도 사유에 따라 상태가 달라지는 곳에서는 던지는 자리에서 지정한다. 예를 들어
"프로바이더를 못 찾음"은 400 이고 "프로바이더가 실패함"은 502 지만 둘 다 LLMError 다.

`str(exc)` 는 **기본어(영어)로 렌더한 문장**이다. 로그와 기존 코드가 그대로 돈다.
"""

from __future__ import annotations

from typing import Any, Mapping

from . import messages


def jsonable(value: Any) -> Any:
    """
    파라미터를 JSON 응답에 실을 수 있는 모양으로.

    치환에는 무엇을 넣어도 되지만(Path, 예외, 집합 …) 응답 본문에는 못 싣는다.
    모르는 것은 문자열로 만든다 — 오류를 알리다 직렬화에서 다시 죽지 않게.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonable(v) for v in value]
    return str(value)


def listing(values: Any) -> str:
    """
    "사용 가능: a, b, c" 처럼 목록을 문구에 끼워 넣을 때 쓰는 파라미터 변환.

    비어 있을 때 `(none)` 같은 단어를 쓰지 않는 이유는 그것도 문구이기 때문이다.
    대시 하나는 어느 언어에서도 그대로 읽힌다.
    """
    return ", ".join(str(v) for v in values) or "-"


class AppError(Exception):
    """
    이 서버가 만드는 모든 오류의 기반.

        code    `<영역>.<사유>`. 카탈로그(config/messages/)의 키다.
        params  문구 치환값이자 응답의 `error.params`.
        status  HTTP 상태 힌트. WS 경로에서는 쓰이지 않는다.
    """

    # 코드를 주지 않고 던졌을 때 쓸 코드. 하위 클래스가 자기 영역으로 덮는다.
    default_code: str = "internal.error"
    # 이 종류의 오류가 기본적으로 뜻하는 HTTP 상태.
    default_status: int = 500

    def __init__(self, code: str | None = None, *, status: int | None = None, **params: Any):
        self.code = code or self.default_code
        self.params: dict[str, Any] = dict(params)
        self.status = int(self.default_status if status is None else status)
        # Exception 의 args 에는 코드만 둔다. 문구는 __str__ 이 그때그때 만든다.
        super().__init__(self.code)

    def message(self, locale: str | None = None) -> str:
        """이 오류의 문장. 로케일을 주지 않으면 기본어."""
        return messages.render(self.code, self.params, locale)

    def json_params(self) -> dict:
        """응답에 실을 파라미터."""
        return {k: jsonable(v) for k, v in self.params.items()}

    def __str__(self) -> str:
        return self.message(None)
