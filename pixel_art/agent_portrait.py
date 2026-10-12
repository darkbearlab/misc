"""GBA Fire Emblem-style portrait (96x80, 15 colours + transparent, RGB555 values)."""
import os
from PIL import Image, ImageDraw

PAL = [
    (0, 0, 0),         # 0 transparent
    (40, 24, 32),      # 1 outline
    (248, 224, 200),   # 2 skin light
    (232, 184, 152),   # 3 skin mid
    (192, 136, 120),   # 4 skin shadow
    (224, 208, 184),   # 5 hair light
    (184, 160, 136),   # 6 hair mid
    (128, 104, 96),    # 7 hair shadow
    (104, 112, 136),   # 8 iris
    (248, 248, 240),   # 9 white
    (200, 200, 200),   # 10 coat mid
    (144, 144, 152),   # 11 coat shadow
    (48, 48, 56),      # 12 suit
    (96, 96, 112),     # 13 suit highlight
    (216, 128, 120),   # 14 mouth
    (88, 72, 80),      # 15 glasses frame
]
W, H = 96, 80

img = Image.new('P', (W, H), 0)
d = ImageDraw.Draw(img)
P = lambda pts, c: d.polygon(pts, fill=c)
L = lambda pts, c, w=1: d.line(pts, fill=c, width=w)
px = lambda x, y, c: img.putpixel((x, y), c)

# --- body ---
P([(22, 80), (26, 68), (34, 61), (44, 58), (58, 58), (66, 61), (74, 68), (78, 80)], 3)   # bare shoulders
P([(30, 66), (36, 62), (44, 60), (40, 66)], 2)                                           # shoulder light
P([(39, 60), (61, 60), (66, 80), (34, 80)], 12)                                           # bodysuit
L([(39, 71), (41, 67), (45, 65)], 13); L([(42, 68), (44, 67)], 13)                       # bust highlights
L([(55, 65), (59, 67), (61, 71)], 13); L([(56, 67), (58, 68)], 13)
L([(50, 66), (50, 80)], 1)                                                                # center seam
L([(41, 60), (36, 70)], 1); L([(59, 60), (64, 70)], 1)                                    # harness straps
L([(34, 74), (66, 74)], 1); d.rectangle([48, 73, 52, 75], fill=10)                         # chest strap + buckle
# coat, slipping off the shoulders
P([(4, 80), (10, 70), (20, 66), (30, 70), (34, 80)], 9)
P([(4, 80), (10, 72), (16, 70), (18, 80)], 10)
P([(24, 72), (30, 72), (34, 80), (28, 80)], 11)
P([(66, 80), (70, 70), (80, 66), (90, 72), (94, 80)], 9)
P([(80, 70), (90, 74), (94, 80), (84, 80)], 10)
P([(66, 80), (70, 72), (74, 74), (72, 80)], 11)
L([(12, 74), (14, 80)], 11); L([(20, 68), (24, 80)], 10)
L([(86, 74), (84, 80)], 11); L([(78, 68), (76, 80)], 10)
# turtleneck
P([(42, 50), (58, 48), (60, 60), (40, 61)], 12)
L([(42, 54), (59, 52)], 13)

# --- head ---
P([(30, 20), (33, 10), (41, 5), (53, 5), (62, 9), (67, 18), (68, 32), (66, 44), (62, 50), (56, 50), (52, 40), (36, 40)], 6)  # hair back
P([(36, 22), (35, 31), (37, 38), (41, 44), (45, 47), (50, 46), (55, 41), (58, 34), (58, 22)], 3)   # face
P([(36, 22), (35, 31), (37, 37), (44, 40), (52, 36), (56, 24)], 2)                                 # face light
P([(52, 38), (58, 30), (58, 36), (55, 42), (50, 46)], 4)                                           # jaw shadow
P([(45, 46), (55, 41), (56, 50), (46, 52)], 4)                                                     # neck
L([(41, 44), (45, 47), (50, 46), (55, 41)], 1)                                                     # jaw line
P([(36, 22), (58, 22), (56, 30), (52, 24), (48, 30), (45, 23), (40, 29), (38, 24), (35, 30)], 4)  # bang shadow on forehead
# bangs / front hair
P([(31, 22), (34, 12), (42, 7), (54, 7), (62, 12), (64, 22), (58, 22), (55, 27), (52, 21), (48, 27), (45, 20), (40, 26), (38, 21), (34, 28)], 5)
P([(54, 7), (62, 12), (64, 22), (58, 22)], 6)
P([(31, 22), (34, 28), (33, 40), (36, 44), (31, 42), (29, 32)], 6)       # front lock (far side)
P([(58, 22), (62, 20), (65, 30), (64, 44), (61, 48), (59, 40)], 6)       # side lock (near side)
P([(62, 26), (66, 30), (65, 44), (62, 48)], 7)
L([(36, 14), (40, 11), (46, 10), (52, 11)], 9)                            # hair ring highlight
L([(37, 15), (41, 12)], 5)
L([(58, 12), (63, 22)], 7); L([(66, 22), (67, 34)], 7); L([(60, 30), (62, 42)], 7)  # back strands
L([(32, 30), (33, 39)], 7)
L([(45, 20), (48, 27)], 7); L([(52, 21), (55, 27)], 7)                   # bang separations

# --- face details ---
# eyes (3/4 left): far eye narrower
for x0, w in ((38, 5), (47, 7)):
    d.rectangle([x0, 30, x0 + w - 1, 33], fill=9)
    d.rectangle([x0 + 1, 30, x0 + w - 3, 33], fill=8)
    px(x0 + 1, 30, 1); L([(x0, 29), (x0 + w - 1, 29)], 1)                 # upper lash
    px(x0 + 2, 31, 9)                                                     # highlight
L([(38, 27), (42, 26)], 7); L([(47, 26), (53, 26)], 7)                   # brows
# glasses
d.rectangle([36, 28, 43, 35], outline=15)
d.rectangle([45, 28, 55, 35], outline=15)
L([(43, 31), (45, 31)], 15); L([(55, 30), (60, 29)], 15)
px(37, 34, 9); px(46, 34, 9)                                             # lens glint
px(43, 37, 4); px(42, 38, 4)                                             # nose
L([(43, 42), (46, 42)], 14)                                              # mouth

pal = sum(PAL, ())
img.putpalette(pal + (0, 0, 0) * (256 - len(PAL)))

# outline pass: every filled pixel next to transparency becomes outline
src = img.copy()
for y in range(H):
    for x in range(W):
        if src.getpixel((x, y)) == 0:
            continue
        if any(not (0 <= x + dx < W and 0 <= y + dy < H) or src.getpixel((x + dx, y + dy)) == 0
               for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            if y < H - 1:
                img.putpixel((x, y), 1)

img.info['transparency'] = 0
d_ = os.path.dirname(os.path.abspath(__file__))
img.save(os.path.join(d_, 'agent_portrait_96x80.png'), transparency=0)
big = img.convert('RGBA').resize((W * 6, H * 6), Image.NEAREST)
bg = Image.new('RGBA', big.size, (96, 120, 168, 255))
bg.alpha_composite(big)
bg.save(os.path.join(d_, 'agent_portrait_preview.png'))
