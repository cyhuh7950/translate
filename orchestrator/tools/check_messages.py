#!/usr/bin/env python3
"""
메시지 카탈로그 검증 — "코드는 있는데 문구가 없다"를 배포 전에 잡는다.

오류 문구가 소스에 없고 카탈로그에만 있으므로, 코드를 하나 추가하고 카탈로그를
깜빡하면 사용자는 문장 대신 `[missing message template: ...]` 을 보게 된다.
그 사고를 CI 나 커밋 전에 잡는 것이 이 스크립트의 일이다.

무엇을 보는가
-------------
  1. 소스가 쓰는 코드가 `en.yaml` 에 전부 있는가        → 없으면 실패
  2. 카탈로그에만 있고 아무도 안 쓰는 죽은 키가 있는가  → 보고 (기본은 실패 아님)
  3. 번역본에만 있고 원본(en)에 없는 키가 있는가        → 실패 (오타의 신호다)
  4. 번역본의 치환 이름이 원본과 같은가                 → 실패 (그 문구만 조용히 깨진다)
  5. 원본에 없고 번역본에만 있는 로케일 커버리지        → 보고

사용법
------
    python3 orchestrator/tools/check_messages.py
    python3 orchestrator/tools/check_messages.py --strict     # 죽은 키도 실패로
    python3 orchestrator/tools/check_messages.py --config-dir /config --source-dir ...

코드를 어떻게 찾는가
--------------------
AST 로 훑는다. 정규식으로 문자열을 긁으면 주석과 문서의 예시까지 잡힌다.

  · `SomethingError("code", ...)`  — 이름이 Error 로 끝나는 호출의 첫 인자
  · `messages.render("code", ...)` / `render("code", ...)`
  · `has("code")`
  · 클래스 본문의 `default_code = "code"`
  · `upstream.failure(SomethingError, "code", ...)` — 예외 클래스가 앞에 오므로
    첫 **문자열** 인자를 본다. 이 자리는 코드가 두 벌이라 `code` 와 `code_detail`
    을 함께 요구한다 (상류 본문을 실을 때 다른 코드를 쓴다 — app/core/upstream.py).

코드가 실행 시점에 조립되는 자리(`f"http.{status}"`)는 AST 로 알 수 없다. 그런
이름공간은 `defaults.yaml` 의 `messages.dynamic_prefixes` 에 적어두면 죽은 키로
보고하지 않는다 — 접두사를 코드에 나열하지 않기 위해서다.
"""

from __future__ import annotations

import argparse
import ast
import string
import sys
from pathlib import Path

import yaml

# 이 스크립트는 저장소 안에서 도는 개발 도구다. 기본 경로는 저장소 구조에서 온다.
REPO = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_DIR = REPO / "config"
DEFAULT_SOURCE_DIR = REPO / "orchestrator" / "app"

# 카탈로그 하위 디렉터리와 기본 로케일은 서버 코드와 같은 값을 쓴다.
MESSAGES_SUBDIR = "messages"
FALLBACK_LOCALE = "en"

# 상류 응답 본문을 실은 코드에 붙는 접미사. app/core/upstream.py 와 같은 값이어야 한다.
DETAIL_SUFFIX = "_detail"

# 코드처럼 생긴 문자열만 코드로 본다. `<영역>.<사유>` 이고 점이 하나 이상.
_CODE_CHARS = set(string.ascii_lowercase + string.digits + "._")


def looks_like_code(value: str) -> bool:
    return (
        bool(value)
        and "." in value
        and not value.startswith(".")
        and not value.endswith(".")
        and set(value) <= _CODE_CHARS
    )


def _first_string_arg(call: ast.Call) -> str | None:
    """첫 인자가 문자열 리터럴이면 그것. 아니면 None."""
    if not call.args:
        return None
    first = call.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value
    return None


def _any_string_arg(call: ast.Call) -> str | None:
    """위치 인자 중 처음 나오는 문자열 리터럴. 앞에 예외 클래스가 오는 자리에 쓴다."""
    for arg in call.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            return arg.value
    return None


def _callee_name(call: ast.Call) -> str:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def collect_used(source_dir: Path) -> dict[str, set[Path]]:
    """소스가 쓰는 코드 → 그 코드가 나온 파일들."""
    used: dict[str, set[Path]] = {}

    def note(code: str, path: Path) -> None:
        if looks_like_code(code):
            used.setdefault(code, set()).add(path)

    for path in sorted(source_dir.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as exc:
            print(f"  ! could not parse {path}: {exc}", file=sys.stderr)
            continue

        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = _callee_name(node)
                if name == "failure":
                    # upstream.failure(ErrorClass, "code", ...) — 코드는 두 벌이다.
                    value = _any_string_arg(node)
                    if value is not None:
                        note(value, path)
                        note(value + DETAIL_SUFFIX, path)
                elif name.endswith("Error") or name in {"render", "has", "message"}:
                    value = _first_string_arg(node)
                    if value is not None:
                        note(value, path)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                # `default_code = "..."` 와 `default_code: str = "..."` 둘 다.
                if isinstance(node, ast.Assign):
                    names = [t.id for t in node.targets if isinstance(t, ast.Name)]
                else:
                    names = [node.target.id] if isinstance(node.target, ast.Name) else []
                if "default_code" in names and isinstance(node.value, ast.Constant):
                    if isinstance(node.value.value, str):
                        note(node.value.value, path)
    return used


def load_catalogs(config_dir: Path) -> dict[str, dict[str, str]]:
    directory = config_dir / MESSAGES_SUBDIR
    if not directory.is_dir():
        sys.exit(f"Message catalog directory not found: {directory}")
    out: dict[str, dict[str, str]] = {}
    for path in sorted(directory.glob("*.yaml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            sys.exit(f"The top level of {path} must be a mapping")
        out[path.stem] = {str(k): str(v) for k, v in data.items() if v is not None}
    if FALLBACK_LOCALE not in out:
        sys.exit(f"The catalog has no {FALLBACK_LOCALE}.yaml — that file is the original")
    return out


def placeholders(template: str) -> set[str]:
    """`{name}` 들. `{{` 는 이스케이프라 무시된다."""
    return {
        field for _, field, _, _ in string.Formatter().parse(template) if field
    }


def dynamic_prefixes(config_dir: Path) -> list[str]:
    """실행 시점에 조립되는 코드의 이름공간. 설정에서 온다."""
    defaults = config_dir / "defaults.yaml"
    if not defaults.is_file():
        return []
    data = yaml.safe_load(defaults.read_text(encoding="utf-8")) or {}
    section = (data.get("messages") or {}) if isinstance(data, dict) else {}
    value = section.get("dynamic_prefixes") or []
    return [str(v) for v in value]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--config-dir", type=Path, default=DEFAULT_CONFIG_DIR)
    ap.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    ap.add_argument(
        "--strict", action="store_true", help="죽은 키도 실패로 취급한다"
    )
    args = ap.parse_args()

    catalogs = load_catalogs(args.config_dir)
    original = catalogs[FALLBACK_LOCALE]
    used = collect_used(args.source_dir)
    prefixes = tuple(dynamic_prefixes(args.config_dir))

    problems = 0
    warnings = 0

    print(f"catalog : {args.config_dir / MESSAGES_SUBDIR}")
    for locale in sorted(catalogs):
        print(f"          {locale}.yaml  {len(catalogs[locale])} keys")
    print(f"source  : {args.source_dir}  ({len(used)} codes used)")
    if prefixes:
        print(f"dynamic : {', '.join(prefixes)}")
    print()

    # 1. 소스가 쓰는데 카탈로그에 없는 코드
    missing = sorted(code for code in used if code not in original)
    if missing:
        problems += len(missing)
        print(f"MISSING — used in code but not in {FALLBACK_LOCALE}.yaml ({len(missing)}):")
        for code in missing:
            where = ", ".join(sorted(str(p.relative_to(REPO)) for p in used[code]))
            print(f"  {code}\n      {where}")
        print()

    # 2. 카탈로그에만 있고 아무도 안 쓰는 키
    dead = sorted(
        code
        for code in original
        if code not in used and not (prefixes and code.startswith(prefixes))
    )
    if dead:
        print(f"DEAD — in {FALLBACK_LOCALE}.yaml but never used ({len(dead)}):")
        for code in dead:
            print(f"  {code}")
        print()
        if args.strict:
            problems += len(dead)
        else:
            warnings += len(dead)

    # 3~4. 번역본 점검
    for locale in sorted(catalogs):
        if locale == FALLBACK_LOCALE:
            continue
        table = catalogs[locale]
        extra = sorted(set(table) - set(original))
        if extra:
            problems += len(extra)
            print(f"EXTRA — in {locale}.yaml but not in {FALLBACK_LOCALE}.yaml ({len(extra)}):")
            for code in extra:
                print(f"  {code}")
            print()

        mismatched = []
        for code, template in table.items():
            if code not in original:
                continue
            want = placeholders(original[code])
            got = placeholders(template)
            if want != got:
                mismatched.append((code, sorted(want), sorted(got)))
        if mismatched:
            problems += len(mismatched)
            print(f"PLACEHOLDERS — {locale}.yaml does not match the original ({len(mismatched)}):")
            for code, want, got in mismatched:
                print(f"  {code}\n      expected {want}\n      found    {got}")
            print()

        untranslated = sorted(set(original) - set(table))
        if untranslated:
            warnings += len(untranslated)
            print(
                f"UNTRANSLATED — {locale}.yaml falls back to {FALLBACK_LOCALE} "
                f"({len(untranslated)}):"
            )
            for code in untranslated:
                print(f"  {code}")
            print()

    if problems:
        print(f"FAIL — {problems} problem(s), {warnings} warning(s)")
        return 1
    print(f"OK — {len(used)} codes used, all present. {warnings} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
