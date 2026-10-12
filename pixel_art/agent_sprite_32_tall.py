"""32x32 tall, outlined agent sprite: tiny head, long one-pixel legs, rifle held low and diagonal."""
import os
from PIL import Image
from agent_sprite import PALETTE

ROWS = {
    0:  [(14, "OOOO")],
    1:  [(13, "OHHHHO")],
    2:  [(13, "OHHHHO")],
    3:  [(13, "OhEEhO")],
    4:  [(13, "OhSShO")],
    5:  [(12, "OODssDOO")],
    6:  [(11, "OWSOBBOSWO")],
    7:  [(10, "OWwSBBBBSwWO")],
    8:  [(10, "OWwwBbbBwwWO")],
    9:  [(10, "OWwwBBBBwwWO")],
    10: [(9,  "OWwwGBBBBGwwWO")],
    11: [(9,  "OWwwGBBBBGwwWO")],
    12: [(9,  "OWwBGSBBSGwwWO")],
    13: [(9,  "OWwwOLOOLOwwWO")],
    14: [(9,  "OWwGOLOOLOGwWO")],
    15: [(10, "OWwOLOOLOwWO")],
    16: [(11, "OOLOOOLOOO")],
    **{y: [(12, "OLO.OLO")] for y in range(17, 25)},
    **{y: [(12, "OBO.OBO")] for y in range(25, 29)},
    29: [(12, "OOO.OOO")],
}

# Rifle: muzzle low-left, stock at the left glove.
RIFLE = [(13, 11), (14, 10), (15, 9), (16, 8), (17, 7), (18, 6), (19, 5)]
MAG = [(17, 9)]

def build(scale):
    px = {}
    for y, segs in ROWS.items():
        for x0, s in segs:
            for i, c in enumerate(s):
                if c != '.':
                    px[(x0 + i, y)] = c
    for y, x in RIFLE:
        px[(x, y)] = 'M'
        px[(x + 1, y)] = 'b' if (y, x) != RIFLE[0] else px.get((x + 1, y), 'M')
    for y, x in MAG:
        px[(x, y)] = 'M'
    # one-pixel outline wherever rifle pixels touch transparency
    for (x, y), c in list(px.items()):
        if c in 'Mb':
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if (x + dx, y + dy) not in px:
                    px[(x + dx, y + dy)] = 'O'
    img = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    for (x, y), c in px.items():
        img.putpixel((x, y), PALETTE[c] + (255,))
    assert len(set(px.values())) <= 15
    return img.resize((32 * scale, 32 * scale), Image.NEAREST)

if __name__ == '__main__':
    d = os.path.dirname(os.path.abspath(__file__))
    build(1).save(os.path.join(d, 'agent_tall_32x32.png'))
    big = build(10)
    bg = Image.new('RGBA', big.size, (200, 208, 216, 255))
    bg.alpha_composite(big)
    bg.save(os.path.join(d, 'agent_tall_32x32_preview.png'))
