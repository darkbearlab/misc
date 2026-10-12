"""GBA Fire Emblem-style portrait (96x80, 15 colours + transparent, RGB555 values).

Style notes taken from GBA FE mugs: big head facing left, light from the upper left,
one shared dark-purple outline colour, cream skin with orange shading, hair drawn as
tapered locks, a heavy upper eyelid line."""
import os
from PIL import Image, ImageDraw

PAL = [
    (0, 0, 0),         # 0 transparent
    (80, 56, 88),      # 1 outline
    (248, 248, 208),   # 2 skin light
    (248, 216, 136),   # 3 skin mid
    (240, 168, 88),    # 4 skin shadow
    (200, 112, 56),    # 5 skin dark
    (232, 216, 184),   # 6 hair light
    (192, 168, 144),   # 7 hair mid
    (136, 112, 104),   # 8 hair dark
    (112, 120, 152),   # 9 iris
    (248, 248, 248),   # 10 white
    (200, 200, 216),   # 11 coat mid / glasses frame
    (136, 136, 160),   # 12 coat shadow
    (48, 48, 64),      # 13 suit
    (96, 96, 128),     # 14 suit highlight
    (168, 176, 200),   # 15 iris light
]
W, H = 96, 80
SKIN, HAIR, SUIT, COAT = 1, 2, 3, 4   # region ids

col = Image.new('P', (W, H), 0)
reg = Image.new('L', (W, H), 0)
dc, dr = ImageDraw.Draw(col), ImageDraw.Draw(reg)

def poly(pts, c, r=None):
    dc.polygon(pts, fill=c)
    if r is not None:
        dr.polygon(pts, fill=r)

def line(pts, c, w=1):
    dc.line(pts, fill=c, width=w)

def px(x, y, c):
    col.putpixel((x, y), c)

# ---------- body ----------
poly([(14, 80), (20, 70), (30, 64), (42, 61), (60, 59), (72, 62), (82, 70), (88, 80)], 2, SKIN)   # shoulders
poly([(56, 60), (72, 62), (82, 70), (88, 80), (70, 80), (66, 68)], 3)                            # far-side shading
poly([(36, 64), (64, 61), (70, 80), (32, 80)], 13, SUIT)                                         # bodysuit
line([(38, 72), (42, 67), (48, 66)], 14); line([(55, 65), (61, 66), (65, 71)], 14)            # bust highlights
line([(51, 67), (51, 80)], 1)
line([(38, 64), (33, 72)], 1); line([(63, 61), (68, 72)], 1)                                     # harness straps
line([(34, 76), (68, 76)], 1); dc.rectangle([49, 75, 53, 77], fill=11)
# coat slipping off the shoulders
poly([(0, 80), (4, 72), (14, 68), (24, 70), (32, 80)], 10, COAT)
poly([(0, 80), (4, 74), (10, 72), (12, 80)], 11); line([(20, 71), (24, 80)], 11); line([(14, 72), (16, 80)], 12)
poly([(72, 80), (76, 70), (86, 66), (95, 70), (95, 80)], 10, COAT)
poly([(84, 70), (95, 72), (95, 80), (88, 80)], 11); line([(80, 70), (78, 80)], 12); line([(90, 74), (88, 80)], 12)
# turtleneck
poly([(41, 52), (58, 49), (62, 62), (38, 64)], 13, SUIT)
poly([(54, 50), (58, 49), (62, 62), (57, 62)], 14)
line([(41, 57), (60, 54)], 1)

# ---------- head ----------
HAIR_BACK = [(22, 28), (24, 15), (31, 7), (43, 2), (56, 3), (66, 8), (72, 17), (75, 30), (74, 42),
             (72, 52), (68, 60), (64, 55), (60, 58), (58, 46), (36, 46)]
poly(HAIR_BACK, 7, HAIR)
FACE = [(32, 18), (29, 30), (30, 38), (33, 45), (37, 50), (41, 54), (46, 52), (53, 47), (59, 40), (62, 31), (62, 18)]
poly(FACE, 2, SKIN)
poly([(46, 52), (53, 47), (59, 40), (62, 31), (62, 18), (57, 22), (57, 36), (51, 45)], 3)       # far cheek shade
poly([(44, 52), (56, 46), (58, 58), (46, 60)], 3, SKIN)                                         # neck
poly([(45, 53), (56, 47), (57, 51), (47, 56)], 4)                                               # under-chin shadow
line([(45, 53), (50, 51), (56, 47)], 5)

# bangs: tapered locks hanging over the forehead
BANGS = [(26, 24), (28, 14), (35, 7), (45, 4), (56, 5), (64, 10), (68, 18), (66, 28),
         (63, 25), (62, 37),            # long lock on the near side
         (59, 26), (56, 31),
         (54, 24), (51, 37),            # long lock between the eyes
         (49, 25), (46, 30),
         (44, 24), (40, 34),            # lock over the far eye
         (38, 25), (35, 29),
         (33, 27), (31, 38), (29, 47), (27, 40), (26, 32)]
# hair casts a soft shadow onto the face: draw the bangs shifted down-right in skin-mid first
dc.polygon([(x + 1, y + 2) for x, y in BANGS], fill=3)
poly(BANGS, 6, HAIR)
poly([(55, 5), (64, 10), (68, 18), (66, 28), (63, 25), (62, 37), (59, 26), (58, 18), (56, 10)], 7)  # far side of bangs in shade
poly([(26, 24), (28, 18), (31, 22), (33, 27), (31, 38), (29, 47), (27, 40), (26, 32)], 7)
# side lock on the near (right) side in front of the neck
poly([(62, 22), (68, 18), (72, 30), (70, 44), (66, 54), (63, 46), (61, 34)], 7, HAIR)
# hair shading: locks
for pts, c in [
    ([(44, 6), (38, 14), (34, 22), (31, 32)], 7), ([(48, 6), (45, 14), (43, 22)], 7),
    ([(52, 6), (53, 14), (53, 26)], 7), ([(56, 7), (60, 15), (61, 24)], 7),
    ([(60, 8), (66, 16), (67, 26)], 8), ([(64, 24), (68, 34), (66, 48)], 8),
    ([(70, 22), (72, 34), (70, 48)], 8), ([(33, 26), (29, 36), (28, 44)], 7),
    ([(24, 22), (24, 30)], 8), ([(62, 30), (64, 44), (64, 52)], 8),
]:
    line(pts, c)
line([(36, 26), (38, 22)], 7); line([(47, 27), (48, 22)], 7); line([(52, 30), (53, 22)], 8)
line([(30, 14), (36, 9), (44, 7), (52, 7)], 10)                                                  # shine ring
line([(31, 16), (37, 11), (43, 9)], 6); px(33, 13, 10); px(38, 10, 6)

# ---------- face ----------
# eyes: far eye (left) narrow, near eye (right) wider; heavy upper lid
for x0, w in ((33, 5), (44, 7)):
    dc.rectangle([x0, 35, x0 + w - 1, 38], fill=10)
    dc.rectangle([x0 + 1, 35, x0 + w - 2, 38], fill=9)
    dc.rectangle([x0 + 1, 37, x0 + w - 2, 38], fill=15)
    px(x0 + 2, 36, 10)
    line([(x0 - 1, 34), (x0 + w - 1, 34)], 1); line([(x0, 33), (x0 + w - 2, 33)], 1)
    px(x0 + w - 1, 35, 1)
    line([(x0 + 1, 39), (x0 + w - 2, 39)], 3)
line([(33, 31), (37, 30)], 8); line([(45, 30), (50, 30)], 8)                                     # brows (through bangs gaps)
# glasses: thin light frames
for x0, y0, x1, y1 in ((31, 32, 39, 40), (42, 32, 52, 40)):   # rounded frames
    line([(x0 + 1, y0), (x1 - 1, y0)], 11); line([(x0 + 1, y1), (x1 - 1, y1)], 11)
    line([(x0, y0 + 1), (x0, y1 - 1)], 11); line([(x1, y0 + 1), (x1, y1 - 1)], 11)
line([(40, 35), (41, 35)], 11); line([(53, 34), (60, 32)], 11)
px(32, 39, 10); px(43, 39, 10)
# nose / mouth / cheek
px(39, 43, 4); px(38, 44, 5)
line([(38, 48), (41, 48)], 5); px(42, 47, 4)
line([(52, 43), (55, 40)], 4)

# ---------- outline pass ----------
src_c, src_r = col.copy(), reg.copy()
def R(x, y):
    return src_r.getpixel((x, y)) if 0 <= x < W and 0 <= y < H else 0
for y in range(H):
    for x in range(W):
        r = R(x, y)
        if not r:
            continue
        n = [R(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))]
        edge = any(v == 0 for v in n) and y < H - 1
        hair_over = r == HAIR and any(v == SKIN for v in n)
        if edge or hair_over:
            col.putpixel((x, y), 1)

col.putpalette(sum(PAL, ()) + (0, 0, 0) * (256 - len(PAL)))
col.info['transparency'] = 0
out = os.path.dirname(os.path.abspath(__file__))
col.save(os.path.join(out, 'agent_portrait_96x80.png'), transparency=0)
big = col.convert('RGBA').resize((W * 6, H * 6), Image.NEAREST)
bg = Image.new('RGBA', big.size, (160, 200, 152, 255))
bg.alpha_composite(big)
bg.save(os.path.join(out, 'agent_portrait_preview.png'))
