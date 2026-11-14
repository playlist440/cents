"""Render the Cents app icon: icons/icon.svg, favicon.svg and PNGs (180, 192, 512, 32).

The design is defined once (geometry below) and written both as SVG and as PNGs drawn with
Pillow at 4x and downsampled, so no cairo is needed.

    PYTHONDONTWRITEBYTECODE=1 uv run --python 3.12 --with pillow tools/make_icons.py
"""

from pathlib import Path
import math

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "frontend" / "icons"

# Geometry on a 1024 grid
S = 1024
TOP, BOTTOM = (0x3C, 0xCF, 0x86), (0x0F, 0x86, 0x55)    # Cents green gradient
COIN_C, COIN_R = (512, 512), 318
RIM_R, RIM_W = 262, 12
GLYPH = (0x1F, 0x9D, 0x6B)
ARC_R, ARC_W = 132, 62            # the "¢" bowl
ARC_FROM, ARC_TO = 42, 318        # degrees, opening to the right
STEM_W, STEM_HALF = 50, 196       # the "¢" stem


def svg(rounded=False):
    cx, cy = COIN_C
    a0, a1 = math.radians(ARC_FROM), math.radians(ARC_TO)
    x0, y0 = cx + ARC_R * math.cos(a0), cy - ARC_R * math.sin(a0)
    x1, y1 = cx + ARC_R * math.cos(a1), cy - ARC_R * math.sin(a1)
    rx = ' rx="229"' if rounded else ""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#{TOP[0]:02X}{TOP[1]:02X}{TOP[2]:02X}"/>
      <stop offset="1" stop-color="#{BOTTOM[0]:02X}{BOTTOM[1]:02X}{BOTTOM[2]:02X}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.15" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="coin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#E4F5EC"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
  </defs>
  <rect width="{S}" height="{S}"{rx} fill="url(#bg)"/>
  <rect width="{S}" height="{S}"{rx} fill="url(#glow)"/>
  <circle cx="{cx}" cy="{cy + 26}" r="{COIN_R}" fill="#06492D" opacity="0.32" filter="url(#shadow)"/>
  <circle cx="{cx}" cy="{cy}" r="{COIN_R}" fill="url(#coin)"/>
  <circle cx="{cx}" cy="{cy}" r="{RIM_R}" fill="none" stroke="#{GLYPH[0]:02X}{GLYPH[1]:02X}{GLYPH[2]:02X}" stroke-opacity="0.16" stroke-width="{RIM_W}"/>
  <g fill="none" stroke="#{GLYPH[0]:02X}{GLYPH[1]:02X}{GLYPH[2]:02X}" stroke-linecap="round">
    <path d="M{x0:.1f} {y0:.1f} A{ARC_R} {ARC_R} 0 1 0 {x1:.1f} {y1:.1f}" stroke-width="{ARC_W}"/>
    <path d="M{cx} {cy - STEM_HALF} V{cy + STEM_HALF}" stroke-width="{STEM_W}"/>
  </g>
</svg>
'''


def render(size, rounded=False):
    W = S
    img = Image.new("RGB", (W, W))
    px = img.load()
    for y in range(W):
        t = y / (W - 1)
        c = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = c
    # top-left glow
    glow = Image.new("L", (W, W), 0)
    gd = ImageDraw.Draw(glow)
    gx, gy, gr = 0.3 * W, 0.15 * W, 0.75 * W
    for i in range(60, 0, -1):
        r = gr * i / 60
        gd.ellipse([gx - r, gy - r, gx + r, gy + r], fill=round(56 * (1 - i / 60)))
    img = Image.composite(Image.new("RGB", (W, W), (255, 255, 255)), img, glow)

    cx, cy = COIN_C
    # shadow
    sh = Image.new("L", (W, W), 0)
    ImageDraw.Draw(sh).ellipse([cx - COIN_R, cy + 26 - COIN_R, cx + COIN_R, cy + 26 + COIN_R], fill=82)
    sh = sh.filter(ImageFilter.GaussianBlur(22))
    img = Image.composite(Image.new("RGB", (W, W), (6, 73, 45)), img, sh)

    # supersampled foreground
    F = 4
    big = Image.new("RGBA", (W * F, W * F), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    C = (cx * F, cy * F)

    def circ(r):
        return [C[0] - r * F, C[1] - r * F, C[0] + r * F, C[1] + r * F]

    # coin with vertical gradient
    coin = Image.new("RGBA", (W * F, W * F), (0, 0, 0, 0))
    cd = ImageDraw.Draw(coin)
    top, bot = (255, 255, 255), (0xE4, 0xF5, 0xEC)
    for i in range(0, 2 * COIN_R * F, 4):
        t = i / (2 * COIN_R * F)
        col = tuple(round(top[j] + (bot[j] - top[j]) * t) for j in range(3)) + (255,)
        cd.rectangle([0, C[1] - COIN_R * F + i, W * F, C[1] - COIN_R * F + i + 4], fill=col)
    mask = Image.new("L", (W * F, W * F), 0)
    ImageDraw.Draw(mask).ellipse(circ(COIN_R), fill=255)
    big.paste(coin, (0, 0), mask)

    rim = (208, 235, 224, 255)  # GLYPH at 16% over the coin, opaque (PIL draws without blending)
    d.ellipse(circ(RIM_R + RIM_W / 2), outline=rim, width=RIM_W * F)
    g = GLYPH + (255,)
    # bowl: PIL measures angles clockwise from 3 o'clock, ours counter-clockwise, so the
    # left-hand arc from ARC_FROM..ARC_TO (ccw) is 360-ARC_TO..360-ARC_FROM clockwise.
    box = circ(ARC_R + ARC_W / 2)
    d.arc(box, start=360 - ARC_TO, end=360 - ARC_FROM, fill=g, width=ARC_W * F)
    for a in (ARC_FROM, ARC_TO):
        ar = math.radians(a)
        ex, ey = C[0] + ARC_R * F * math.cos(ar), C[1] - ARC_R * F * math.sin(ar)
        rr = ARC_W * F / 2
        d.ellipse([ex - rr, ey - rr, ex + rr, ey + rr], fill=g)
    # stem with round caps
    sw = STEM_W * F / 2
    d.rectangle([C[0] - sw, C[1] - STEM_HALF * F, C[0] + sw, C[1] + STEM_HALF * F], fill=g)
    for yy in (C[1] - STEM_HALF * F, C[1] + STEM_HALF * F):
        d.ellipse([C[0] - sw, yy - sw, C[0] + sw, yy + sw], fill=g)

    big = big.resize((W, W), Image.LANCZOS)
    img = img.convert("RGBA")
    img.alpha_composite(big)
    if rounded:
        m = Image.new("L", (W * 4, W * 4), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, W * 4 - 1, W * 4 - 1], radius=229 * 4, fill=255)
        img.putalpha(m.resize((W, W), Image.LANCZOS))
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon.svg").write_text(svg())
    (OUT / "favicon.svg").write_text(svg(rounded=True))
    master = render(1024)
    for size, name in [(180, "apple-touch-icon-180.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
        master.convert("RGB").resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    render(1024, rounded=True).resize((32, 32), Image.LANCZOS).save(OUT / "favicon-32.png", optimize=True)
    print("wrote", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()
