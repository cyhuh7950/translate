"""앱 아이콘(런처 아이콘) 생성. 실시간 통역/번역 앱이므로 말풍선 + 음성 파형으로 표현한다.
mipmap 밀도별 ic_launcher.png(둥근 사각형)/ic_launcher_round.png(원형)를 만든다.
sharp/imagemagick이 없는 환경이라 Pillow로 직접 그린다 — 실행 후 결과만 확인하면 되는
일회성 도구라 res/ 트리에 커밋하지 않는다.
"""
import math
from PIL import Image, ImageDraw

BG = (37, 99, 235, 255)       # theme.ts accent (#2563eb)
FG = (255, 255, 255, 255)     # 말풍선
WAVE = (37, 99, 235, 255)     # 파형 (말풍선 위라 배경색과 동일해도 대비됨)

SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

MASTER = 512
SS = 4  # 슈퍼샘플 배율


def draw_glyph(draw, cx, cy, scale):
    """말풍선(꼬리 포함) + 안쪽 음성 파형 막대 3개. scale은 MASTER 기준 배율."""
    bw, bh = 300 * scale, 220 * scale
    left, top = cx - bw / 2, cy - bh / 2 - 10 * scale
    right, bottom = left + bw, top + bh
    radius = 56 * scale
    draw.rounded_rectangle([left, top, right, bottom], radius=radius, fill=FG)

    tail = [
        (left + 70 * scale, bottom - 4 * scale),
        (left + 70 * scale, bottom + 54 * scale),
        (left + 132 * scale, bottom - 4 * scale),
    ]
    draw.polygon(tail, fill=FG)

    bar_w = 26 * scale
    gap = 20 * scale
    heights = [70 * scale, 120 * scale, 90 * scale, 130 * scale, 60 * scale]
    total_w = len(heights) * bar_w + (len(heights) - 1) * gap
    bx = cx - total_w / 2
    mid_y = top + bh / 2
    for h in heights:
        r = bar_w / 2
        draw.rounded_rectangle(
            [bx, mid_y - h / 2, bx + bar_w, mid_y + h / 2], radius=r, fill=WAVE
        )
        bx += bar_w + gap


def make_master(round_variant: bool) -> Image.Image:
    size = MASTER * SS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if round_variant:
        draw.ellipse([0, 0, size, size], fill=BG)
    else:
        radius = size * 0.22
        draw.rounded_rectangle([0, 0, size, size], radius=radius, fill=BG)
    draw_glyph(draw, size / 2, size / 2, SS)
    return img


def main():
    import os

    base = os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "main", "res")
    for round_variant, name in ((False, "ic_launcher.png"), (True, "ic_launcher_round.png")):
        master = make_master(round_variant)
        for folder, px in SIZES.items():
            out = master.resize((px, px), Image.LANCZOS)
            out_dir = os.path.join(base, folder)
            os.makedirs(out_dir, exist_ok=True)
            out.save(os.path.join(out_dir, name))
            print(f"{folder}/{name} -> {px}x{px}")

    # 미리보기용 (프로젝트 루트 옆에 하나 크게)
    make_master(False).resize((512, 512), Image.LANCZOS).save(
        os.path.join(os.path.dirname(__file__), "icon-preview-square.png")
    )
    make_master(True).resize((512, 512), Image.LANCZOS).save(
        os.path.join(os.path.dirname(__file__), "icon-preview-round.png")
    )


if __name__ == "__main__":
    main()
