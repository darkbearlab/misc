"""FE-style portrait built on a GBA mug base: face, eyes and body pixels are taken as-is from
'Nino (Adult, FE7 colours)' by Spoon_Rhythm & MaxTUS (FE-Repo); the hair is cut to a bob,
everything is recoloured to the agent's palette, and glasses are added."""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
src = Image.open(os.path.join(HERE, 'ref_nino_adult.png')).convert('RGB').crop((0, 0, 96, 80))
W, H = src.size

BG = (160, 200, 152)
HAIR = {(120, 240, 56): (232, 216, 184), (90, 205, 57): (192, 168, 144), (98, 139, 90): (136, 112, 104)}
OUT = (88, 64, 96)
MAP = {
    (90, 65, 98): OUT,
    (248, 255, 213): (248, 248, 208), (248, 222, 139): (248, 216, 136),
    (246, 172, 90): (240, 168, 88), (205, 112, 57): (200, 112, 56),
    (50, 144, 186): (104, 112, 144), (192, 232, 232): (200, 208, 224),
    (98, 74, 131): (40, 40, 56), (112, 80, 184): (64, 64, 80), (156, 123, 238): (104, 104, 128),
    (115, 115, 90): (232, 232, 240),
}
COAT_SHADE = (168, 168, 184)

def bob_cut(x):
    """Lowest hair row kept at column x: jagged lock tips around chin height."""
    base = 45 if x < 40 else 50
    return base + (2, 4, 3, 0, 1)[x % 5]

px = {}
for y in range(H):
    for x in range(W):
        c = src.getpixel((x, y))
        if c == BG:
            continue
        if c in HAIR:
            if y > bob_cut(x):
                continue                      # trimmed away
            px[(x, y)] = HAIR[c]
        elif c == (115, 90, 90):
            px[(x, y)] = COAT_SHADE if y >= 52 else OUT
        else:
            px[(x, y)] = MAP[c]

# hair outline along the new bottom edge: drop old hair outlines left floating below the cut
def orig(x, y):
    return src.getpixel((x, y)) if 0 <= x < W and 0 <= y < H else BG
for (x, y), c in list(px.items()):
    if c == OUT and y > bob_cut(x):
        nb = [orig(x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
        if any(n in HAIR for n in nb) and all(n in HAIR or n in (BG, (90, 65, 98)) for n in nb):
            del px[(x, y)]
for (x, y), c in list(px.items()):
    if c in HAIR.values() and any((x + dx, y + dy) not in px for dx, dy in ((0, 1), (1, 0), (-1, 0))):
        px[(x, y)] = OUT

# drop the earring
for (x, y), c in list(px.items()):
    if x > 52 and c in ((104, 112, 144), (200, 208, 224)):
        px[(x, y)] = (240, 168, 88)

# glasses: thin light frames round both eyes
FRAME = COAT_SHADE
def rect(x0, y0, x1, y1):
    for x in range(x0 + 1, x1):
        px[(x, y0)] = px[(x, y1)] = FRAME
    for y in range(y0 + 1, y1):
        px[(x0, y)] = px[(x1, y)] = FRAME
rect(27, 32, 35, 39)
rect(40, 31, 50, 38)
px[(36, 35)] = px[(37, 35)] = px[(38, 34)] = px[(39, 34)] = FRAME

img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
for (x, y), c in px.items():
    img.putpixel((x, y), c + (255,))
colours = {c for c in px.values()}
assert len(colours) <= 15, len(colours)
img.save(os.path.join(HERE, 'agent_portrait_v3_96x80.png'))
big = img.resize((W * 6, H * 6), Image.NEAREST)
bg = Image.new('RGBA', big.size, BG + (255,))
bg.alpha_composite(big)
bg.save(os.path.join(HERE, 'agent_portrait_v3_preview.png'))
print(len(colours), 'colours')
