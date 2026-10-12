"""FE-style portrait v4: face, eyes and body from 'Nino (Adult, FE7 colours)' by
Spoon_Rhythm & MaxTUS (FE-Repo), recoloured; the whole hair (crown and bangs) is redrawn
as a side-parted bob built from tapered locks, lit from the upper left."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
src = Image.open(os.path.join(HERE, 'ref_nino_adult.png')).convert('RGB').crop((0, 0, 96, 80))
W, H = src.size

BG = (160, 200, 152)
SRC_HAIR = {(120, 240, 56), (90, 205, 57), (98, 139, 90)}
SRC_OUT = (90, 65, 98)
OUT = (88, 64, 96)
HL, HM, HD = (232, 216, 184), (192, 168, 144), (136, 112, 104)   # hair light / mid / dark
COAT_SHADE = (168, 168, 184)
MAP = {
    SRC_OUT: OUT,
    (248, 255, 213): (248, 248, 208), (248, 222, 139): (248, 216, 136),
    (246, 172, 90): (240, 168, 88), (205, 112, 57): (200, 112, 56),
    (50, 144, 186): (104, 112, 144), (192, 232, 232): (200, 208, 224),
    (98, 74, 131): (40, 40, 56), (112, 80, 184): (64, 64, 80), (156, 123, 238): (104, 104, 128),
    (115, 115, 90): (232, 232, 240),
}

def orig(x, y):
    return src.getpixel((x, y)) if 0 <= x < W and 0 <= y < H else BG

def bob_cut(x):
    base = 45 if x < 40 else 50
    return base + (2, 4, 3, 0, 1)[x % 5]

# ---- base: everything but the hair ----
px, old_hair = {}, set()
for y in range(H):
    for x in range(W):
        c = orig(x, y)
        if c == BG:
            continue
        if c in SRC_HAIR:
            old_hair.add((x, y))
        elif c == (115, 90, 90):
            px[(x, y)] = COAT_SHADE if y >= 52 else OUT
        else:
            px[(x, y)] = MAP[c]
# old hair outlines (pixels touching only hair / background / outline) go with the hair
for (x, y), c in list(px.items()):
    if c == OUT:
        nb = [orig(x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
        if any(n in SRC_HAIR for n in nb) and all(n in SRC_HAIR or n in (BG, SRC_OUT) for n in nb):
            del px[(x, y)]
            old_hair.add((x, y))
for (x, y), c in list(px.items()):            # drop the earring
    if x > 52 and c in ((104, 112, 144), (200, 208, 224)):
        px[(x, y)] = (240, 168, 88)

# glasses (drawn before the hair so bangs fall over the frames)
def rect(x0, y0, x1, y1):
    for x in range(x0 + 1, x1):
        px[(x, y0)] = px[(x, y1)] = COAT_SHADE
    for y in range(y0 + 1, y1):
        px[(x0, y)] = px[(x1, y)] = COAT_SHADE
rect(27, 32, 35, 39)
rect(40, 31, 50, 38)
for p in ((36, 35), (37, 35), (38, 34), (39, 34)):
    px[p] = COAT_SHADE

# ---- new hair ----
# Every old hair pixel above the bob line must stay covered, since there is no face under it.
base_mask = {(x, y) for x, y in old_hair if y <= bob_cut(x)}

# One silhouette for the whole bob: crown, near-side lock down to the jaw, and a zig-zag of
# bang tips that stops above the eyes (tips only reach down between them).
SILHOUETTE = [(18, 26), (22, 16), (30, 9), (42, 5), (54, 5), (64, 9), (70, 18), (72, 30), (71, 44),
              (67, 54), (62, 50), (60, 40), (58, 30),
              (56, 31), (54, 22), (51, 31), (48, 22), (44, 29), (41, 22), (38, 33),
              (36, 23), (33, 29), (31, 24), (30, 34), (28, 47), (24, 42), (20, 34)]
m = Image.new('1', (W, H), 0)
ImageDraw.Draw(m).polygon(SILHOUETTE, fill=1)
mask = base_mask | {(x, y) for y in range(H) for x in range(W) if m.getpixel((x, y))}

# Light from the upper left: light / mid / dark bands by a tilted distance from the crown.
hair = {}
for x, y in mask:
    t = (x - 18) * 0.55 + (y - 4) * 0.9
    hair[(x, y)] = HL if t < 16 else HM if t < 40 and x < 66 else HD

# Strands from the part out to each tip: dark core, with a lit edge on its left in the light band.
PART = (50, 7)
TIPS = [(21, 34), (27, 44), (33, 28), (38, 32), (44, 28), (51, 30), (56, 30), (63, 48), (68, 44), (66, 30)]
d = ImageDraw.Draw(sm := Image.new('L', (W, H), 0))
for tx, ty in TIPS:
    # quadratic curve: leaves the part sideways, then falls down to the tip
    sx, sy = PART[0] + (tx - PART[0]) * 0.25, PART[1] - 1
    cx, cy = tx + (2 if tx < PART[0] else -2), sy + 2
    pts = [((1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * tx,
            (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * ty) for t in [k / 16 for k in range(17)]]
    d.line(pts, fill=1)
for y in range(H):
    for x in range(W):
        if sm.getpixel((x, y)) and (x, y) in hair:
            hair[(x, y)] = HD if hair[(x, y)] != HD else OUT
            if (x - 1, y) in hair and hair[(x - 1, y)] == HM:
                hair[(x - 1, y)] = HL
# shine ring
for x in range(27, 49):
    y = 10 + round(((x - 38) / 11) ** 2 * 2)
    if (x, y) in hair and x % 4:
        hair[(x, y)] = (248, 248, 208)

# outline: hair pixels touching background or skin
SKINS = {(248, 248, 208), (248, 216, 136), (240, 168, 88), (200, 112, 56)}
for (x, y) in list(hair):
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        q = (x + dx, y + dy)
        if q not in hair and (q not in px or px[q] in SKINS):
            hair[(x, y)] = OUT
            break
px.update(hair)

img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
for (x, y), c in px.items():
    img.putpixel((x, y), c + (255,))
colours = set(px.values())
assert len(colours) <= 15, len(colours)
img.save(os.path.join(HERE, 'agent_portrait_v4_96x80.png'))
big = img.resize((W * 6, H * 6), Image.NEAREST)
bg = Image.new('RGBA', big.size, BG + (255,))
bg.alpha_composite(big)
bg.save(os.path.join(HERE, 'agent_portrait_v4_preview.png'))
print(len(colours), 'colours')
