"""
진단 — VAD 가 확정한 세그먼트를 디스크에 남긴다.

핸즈프리에서 인식이 나쁘다는 말을 추측으로 좇지 않기 위한 도구다. STT 에 **실제로**
들어간 오디오를 그대로 들어보면 앞 음절이 잘렸는지, 종결어미가 날아갔는지,
잡음이 발화로 잡혔는지가 바로 드러난다. 지표만 봐서는 알 수 없는 것들이다.

프라이버시
----------
**켜면 사용자 음성이 평문 WAV 로 디스크에 남는다.** 기본값은 꺼짐이고, 운영에서는
꺼둔 채로 두어야 한다. 켜는 방법과 그 대가는 defaults.yaml 의 `diagnostics:` 주석에 있다.

실패 정책
---------
여기서 나는 오류는 파이프라인을 멈추지 않는다. 디스크가 가득 찼다고 번역이 죽으면
진단을 켤 수 없게 되고, 그러면 이 기능은 없느니만 못하다. 호출자(modules/translate/streaming.py)가
전부 감싸서 로그만 남긴다.

파일 이름
---------
    20260807-153012-482_seg0003_3480ms_안녕하세요_반갑습니다.wav
    20260807-153012-482_seg0003_3480ms_안녕하세요_반갑습니다.json

앞이 타임스탬프라 이름순 정렬이 곧 시간순이다. `keep_last` 로 오래된 것부터 지울 때
이 성질을 그대로 쓴다 — 파일 mtime 을 믿지 않아도 된다(복사·rsync 로 흐트러진다).
"""

from __future__ import annotations

import json
import logging
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("diagnostics")

WAV_SUFFIX = ".wav"
SIDECAR_SUFFIX = ".json"

# 파일 이름의 타임스탬프. 밀리초까지 넣는 이유는 짧은 세그먼트가 연달아 확정될 때
# 이름이 겹치지 않게 하기 위해서다. 표시 형식이라 설정값이 아니다.
_STAMP_FORMAT = "%Y%m%d-%H%M%S-%f"


def _slug(text: str, limit: int) -> str:
    """
    인식된 텍스트를 파일 이름에 넣을 수 있게 다듬는다.

    허용 문자를 정규식 범위로 나열하지 않는다. 한국어만 쓰는 것이 아니고, 범위표를
    적어두면 언어가 늘 때마다 여기를 고쳐야 한다. `isalnum()` 은 유니코드를 알고 있다.
    """
    if not text or limit <= 0:
        return ""
    out: list[str] = []
    separated = False
    for ch in unicodedata.normalize("NFC", text):
        if ch.isalnum():
            out.append(ch)
            separated = False
        elif not separated:
            out.append("_")
            separated = True
    return "".join(out).strip("_")[:limit].strip("_")


def _prune(directory: Path, keep_last: int) -> int:
    """최근 `keep_last` 개만 남기고 지운다. 0 이하면 지우지 않는다."""
    if keep_last <= 0:
        return 0
    wavs = sorted(p for p in directory.glob("*" + WAV_SUFFIX) if p.is_file())
    removed = 0
    for old in wavs[:-keep_last]:
        old.unlink(missing_ok=True)
        # 사이드카는 확장자만 다르다. with_suffix() 는 이름 안의 점에 걸리므로 쓰지 않는다.
        old.with_name(old.stem + SIDECAR_SUFFIX).unlink(missing_ok=True)
        removed += 1
    return removed


def save_segment(
    cfg: Any,
    *,
    wav: bytes,
    seg: int,
    duration_ms: int,
    label: str,
    record: dict,
) -> Path:
    """
    세그먼트 WAV 와 사이드카 JSON 을 쓰고, 넘치는 오래된 파일을 지운다.

    켜고 끄는 판단은 호출자가 한다 — 꺼져 있을 때 record 를 만드는 비용조차 들지
    않게 하기 위해서다. 여기까지 왔으면 저장한다.

    돌려주는 값은 쓴 WAV 경로다(로그용).
    """
    directory = Path(cfg.get("diagnostics.segment_dir"))
    directory.mkdir(parents=True, exist_ok=True)

    now = datetime.now()
    stamp = now.strftime(_STAMP_FORMAT)[:-3]        # 마이크로초 → 밀리초
    slug = _slug(label, int(cfg.get("diagnostics.filename_text_chars")))
    base = f"{stamp}_seg{seg:04d}_{duration_ms}ms" + (f"_{slug}" if slug else "")

    wav_path = directory / (base + WAV_SUFFIX)
    sidecar_path = directory / (base + SIDECAR_SUFFIX)

    wav_path.write_bytes(wav)
    sidecar = {"ts": now.isoformat(timespec="milliseconds"), "file": wav_path.name, **record}
    sidecar_path.write_text(
        json.dumps(sidecar, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )

    _prune(directory, int(cfg.get("diagnostics.keep_last")))
    return wav_path
