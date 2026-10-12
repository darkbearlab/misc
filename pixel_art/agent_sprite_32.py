"""32x32 slim front-facing agent sprite, same GBA-style palette as the 16x16 versions."""
import os
from PIL import Image
from agent_sprite import PALETTE

PALETTE = dict(PALETTE, l=(64, 48, 48))  # stocking shadow; 15 colours total

# Each row: list of (start column, pixels). Unlisted pixels are transparent.
ROWS = {
    1:  [(13, "HHHHHH")],
    2:  [(12, "HHHHHHHH")],
    3:  [(11, "hHHHHHHHHh")],
    4:  [(11, "hHHHHHHHHh")],
    5:  [(11, "hhSSSSSShh")],
    6:  [(11, "hhSESSEShh")],
    7:  [(11, "DhsSSSSshD")],
    8:  [(11, "DD"), (14, "sSSs"), (19, "DD")],
    9:  [(14, "BBBB")],
    10: [(10, "WWSSBBBBSSWW")],
    11: [(10, "WwSBBbbBBSwW"), (22, "MM")],
    12: [(10, "WwwBBBBBBwwW"), (22, "MM")],
    13: [(10, "WwwBBBBBBwwW"), (22, "M")],
    14: [(10, "WwwGBBBBGwwW"), (22, "M")],
    15: [(10, "WwwGBBBBGwwW"), (22, "M")],
    16: [(10, "WwwSBBBBSwwW"), (22, "M")],
    17: [(10, "WwBLLBBLLwBB"), (22, "Mb")],
    18: [(10, "WwGLLGGLLGwW"), (22, "Mb")],
    19: [(10, "WwGLlGGlLGwW"), (22, "Mb")],
    20: [(10, "WwGLlGGlLGwW"), (22, "M")],
    21: [(10, "WwGLl..lLGwW"), (22, "M")],
    22: [(10, "WwGLl..lLGwW"), (22, "M")],
    23: [(10, "WwGLl..lLGwW"), (22, "M")],
    24: [(10, "ww.Ll..lL.ww"), (22, "M")],
    25: [(10, "ww.Ll..lL.ww"), (22, "M")],
    26: [(13, "Ll"), (17, "lL")],
    27: [(13, "BB"), (17, "BB")],
    28: [(12, "BBB"), (17, "BBB")],
    29: [(12, "BBB"), (17, "BBB")],
    30: [(12, "OOO"), (17, "OOO")],
}

def build(scale):
    img = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    used = set()
    for y, segs in ROWS.items():
        for x0, px in segs:
            for i, c in enumerate(px):
                if c != '.':
                    img.putpixel((x0 + i, y), PALETTE[c] + (255,))
                    used.add(c)
    assert len(used) <= 15 and all(0 <= x0 and x0 + len(p) <= 32 for s in ROWS.values() for x0, p in s)
    return img.resize((32 * scale, 32 * scale), Image.NEAREST)

if __name__ == '__main__':
    d = os.path.dirname(os.path.abspath(__file__))
    build(1).save(os.path.join(d, 'agent_slim_32x32.png'))
    big = build(10)
    bg = Image.new('RGBA', big.size, (200, 208, 216, 255))
    bg.alpha_composite(big)
    bg.save(os.path.join(d, 'agent_slim_32x32_preview.png'))
