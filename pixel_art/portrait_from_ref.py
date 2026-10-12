"""Designed pixel-art portrait (96x80, GBA FE mug size) traced from the character sheet.

Not a plain downscale: the bust is split into hand-traced material regions (hair, skin,
suit, background), each region gets its own hand-picked 3-tone ramp, tones are chosen per
pixel from the underlying painting's luminance (cel-shaded, no dithering), source line art
becomes a single outline colour, and stray single pixels are cleaned up."""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
CROP = (75, 10, 315, 210)          # bust area of the sheet (hand-traced coords live here)
W, H = 96, 80
S = 2.2                            # view window inside the crop
OX, OY = 25, 4

OUT = (56, 40, 48)
RAMPS = {   # shadow, mid, light
    'hair': [(136, 112, 104), (184, 160, 144), (224, 208, 184)],
    'skin': [(208, 144, 128), (240, 200, 176), (248, 232, 216)],
    'suit': [(32, 32, 40), (64, 64, 80), (112, 112, 128)],
}
HAIR_SHINE = (248, 240, 224)
STRAND = (112, 88, 88)            # hair strand lines, softer than the outline

src = Image.open(os.path.join(HERE, 'ref_sheet.webp')).convert('RGB').crop(CROP)
src = src.filter(ImageFilter.MedianFilter(3))
rgb = np.asarray(src).astype(float)
lum = rgb @ [0.299, 0.587, 0.114]
h, w = lum.shape

def mask(polys):
    m = Image.new('L', (w, h), 0)
    for p in polys:
        ImageDraw.Draw(m).polygon(p, fill=1)
    return np.asarray(m).astype(bool)

# --- hand-traced regions on the 240x200 crop ---
FACE = mask([
    [(72, 100), (84, 104), (96, 98), (102, 92), (110, 86), (120, 84), (132, 88), (138, 96), (140, 110),
     (136, 126), (126, 138), (112, 146), (104, 148), (92, 140), (82, 130), (74, 118)],
    [(100, 72), (112, 68), (122, 72), (118, 84), (104, 88)],
])
SUIT = mask([[(78, 146), (95, 150), (128, 140), (146, 146), (156, 170), (166, 200), (52, 200), (62, 176), (72, 160)]])
LOWER = np.zeros((h, w), bool); LOWER[150:, :] = True

# background: flood fill from the borders over the pale paper colour
bgref = np.array([236, 236, 236])
pale = np.abs(rgb - bgref).max(axis=2) < 14
bg = np.zeros((h, w), bool)
stack = [(0, x) for x in range(w)] + [(y, 0) for y in range(h)] + [(y, w - 1) for y in range(h)]
while stack:
    y, x = stack.pop()
    if 0 <= y < h and 0 <= x < w and pale[y, x] and not bg[y, x]:
        bg[y, x] = True
        stack += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]

blur = np.asarray(Image.fromarray(lum.astype('uint8')).filter(ImageFilter.GaussianBlur(3))).astype(float)
dark = (lum < blur - 18) | (lum < 80)
lum_s = np.asarray(Image.fromarray(lum.astype('uint8')).filter(ImageFilter.GaussianBlur(2))).astype(float)      # source line art: locally darker than its surroundings
label = np.full((h, w), 'hair', dtype=object)
label[FACE] = 'skin'
label[LOWER & ~SUIT] = 'skin'          # bare shoulders
label[SUIT] = 'suit'
label[bg] = 'bg'

# per-region luminance thresholds (designed split: deepest 30% shadow, brightest 15% light)
thr = {}
for r in RAMPS:
    v = lum[(label == r) & ~dark] if r != 'suit' else lum[label == r]
    thr[r] = (np.percentile(v, 30), np.percentile(v, 85))

# --- downscale by footprint: majority label, mean luminance, line-art coverage ---
out = {}
for Y in range(H):
    for X in range(W):
        y0, y1 = int(OY + Y * S), int(OY + (Y + 1) * S + 0.999)
        x0, x1 = int(OX + X * S), int(OX + (X + 1) * S + 0.999)
        lab = label[y0:y1, x0:x1].ravel()
        vals, counts = np.unique(lab, return_counts=True)
        r = vals[counts.argmax()]
        if r == 'bg':
            continue
        dk = dark[y0:y1, x0:x1]
        if r == 'skin' and FACE[y0:y1, x0:x1].any():
            dk = np.zeros_like(dk)          # face features are drawn by hand below
        if r == 'hair' and dk.mean() > 0.5:
            out[(X, Y)] = OUT
            continue
        if r == 'hair' and dk.mean() > 0.22:
            out[(X, Y)] = STRAND
            continue
        if r != 'suit' and r != 'hair' and dk.mean() > 0.3:
            out[(X, Y)] = OUT
            continue
        L_ = lum_s if r == 'hair' else lum
        sel = (label[y0:y1, x0:x1] == r) & (~dk if r != 'suit' else True)
        v = L_[y0:y1, x0:x1][sel].mean() if sel.any() else L_[y0:y1, x0:x1].mean()
        lo, hi = thr[r]
        tone = 0 if v < lo else 2 if v > hi else 1
        c = RAMPS[r][tone]
        if r == 'hair' and v > np.percentile(lum[label == 'hair'], 97):
            c = HAIR_SHINE
        out[(X, Y)] = c

# --- cleanup ---
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
N8 = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
def smooth(out):
    """Flat colour areas: a tone pixel with fewer than 3 same-coloured neighbours joins the
    most common tone around it; an outline pixel with at most one outline neighbour (a speck,
    not a line) is dropped the same way."""
    new = dict(out)
    for (x, y), c in out.items():
        nb = [out.get((x + dx, y + dy)) for dx, dy in N8]
        same = nb.count(c)
        line = c in (OUT, STRAND)
        if (line and same + nb.count(OUT if c == STRAND else STRAND) <= 1) or (not line and same < 3):
            tones = [n for n in nb if n is not None and n not in (OUT, STRAND)]
            if len(tones) >= 4:
                new[(x, y)] = max(set(tones), key=tones.count)
    return new
for _ in range(3):
    out = smooth(out)

# --- hand-drawn face features (positions traced from the sheet, in crop coords) ---
def T(x, y):
    return round((x - OX) / S), round((y - OY) / S)
IRIS, WHITE = (104, 96, 112), (248, 248, 240)
def put(p, c):
    out[p] = c
def eye(cx, cy, wdt, tilt):
    """FE-style eye: thick upper lid, dark-topped iris, one highlight."""
    X, Y = T(cx, cy)
    half = wdt // 2
    for i in range(-half - 1, half + 1):            # upper lid, 2px, slanting with the head
        yy = Y - 2 - round(i * tilt)
        put((X + i, yy), OUT); put((X + i, yy + 1), OUT)
    for i in range(-half, half):
        yy = Y - round(i * tilt)
        put((X + i, yy), WHITE); put((X + i, yy + 1), WHITE)
    for dx in (-1, 0, 1):                            # iris
        put((X + dx, Y - round(dx * tilt)), OUT)
        put((X + dx, Y + 1 - round(dx * tilt)), IRIS)
    put((X, Y + 2), IRIS)
    put((X - 1, Y), WHITE)                           # highlight
    for i in range(-half + 1, half - 1):             # lower lid
        put((X + i, Y + 3 - round(i * tilt)), RAMPS['skin'][0])
def ring(x0, y0, x1, y1):
    """Round lens: outline of an ellipse (drawn on a scratch mask, then copied)."""
    a, b = T(x0, y0), T(x1, y1)
    m = Image.new('1', (W, H), 0)
    ImageDraw.Draw(m).ellipse([a, b], outline=1)
    for y in range(H):
        for x in range(W):
            if m.getpixel((x, y)):
                put((x, y), OUT)
eye(80, 108, 7, 0.25)          # far eye
eye(117, 95, 9, 0.25)          # near eye
ring(64, 97, 96, 124)          # glasses
ring(99, 83, 136, 110)
bx, by = T(97, 106); put((bx, by), OUT); put((bx + 1, by - 1), OUT)
mx, my = T(102, 131)
for dx in range(4):
    put((mx + dx, my - (dx > 2)), RAMPS['skin'][0])
nx, ny = T(107, 120); put((nx, ny), RAMPS['skin'][0])

# outer outline against the background
for (x, y), c in list(out.items()):
    if y < H - 1 and any((x + dx, y + dy) not in out for dx, dy in N4):
        out[(x, y)] = OUT

img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
for (x, y), c in out.items():
    img.putpixel((x, y), c + (255,))
cols = set(out.values())
assert len(cols) <= 15, len(cols)
img.save(os.path.join(HERE, 'portrait_96x80.png'))
big = img.resize((W * 6, H * 6), Image.NEAREST)
bgc = Image.new('RGBA', big.size, (160, 200, 152, 255))
bgc.alpha_composite(big)
bgc.save(os.path.join(HERE, 'portrait_preview.png'))
print(len(cols), 'colours')
