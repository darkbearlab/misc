"""16x16 front-facing sprite: short light-haired agent with off-shoulder coat and rifle.
Palette is GBA-style: 15 colours + transparent, every value on the RGB555 grid (multiples of 8)."""
from PIL import Image

PALETTE = {
    '.': None,             # 0 transparent
    'O': (24, 16, 32),     # outline
    'B': (40, 40, 48),     # bodysuit black
    'b': (80, 80, 96),     # bodysuit highlight
    'S': (240, 208, 184),  # skin
    's': (200, 160, 144),  # skin shadow
    'H': (216, 192, 168),  # hair light
    'h': (168, 144, 128),  # hair mid
    'D': (120, 104, 96),   # hair dark
    'W': (232, 232, 224),  # coat white
    'w': (184, 184, 184),  # coat shadow
    'G': (120, 120, 128),  # coat inner shadow
    'L': (88, 64, 64),     # stockings
    'E': (96, 104, 120),   # eyes / glasses
    'M': (16, 16, 16),     # rifle
}

GRID = """
......OOOO......
.....OHHHHO.....
....OHHhHHhO....
....OhESSEhO....
....ODsSSsDO....
....ODOBBODO....
...OSSBBBBSSO...
..OWSsBbbBsSWO..
.OWwwOBBBBOwwWO.
.OWwwOBBBBOMbWO.
.OWGwSBBBMbwGWO.
.OWGGLLMbLLGGWO.
.OWGGMbGGLLGGWO.
.OOOOLLO.OLLOOOO
....OLLO.OLLO...
...OBBBO.OBBBO..
"""

# Slim variant: no outlines, one pixel per body part.
GRID_SLIM = """
................
......HHHH......
.....hHHHHh.....
.....hESSEh.....
.....DsSSsD.....
.......BB.......
.....WSBBSW.....
.....WBbBBW.....
.....WBBBBWM....
.....wBBBBwM....
.....wSBBSBM....
.....wLGGLwM....
.....wLGGLw.....
......L..L......
......L..L......
.....BB..BB.....
"""

def build(scale, grid=GRID):
    rows = grid.strip().splitlines()
    assert len(rows) == 16 and all(len(r) == 16 for r in rows), [len(r) for r in rows]
    used = {c for r in rows for c in r}
    assert len([c for c in used if c != '.']) <= 15
    img = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            if PALETTE[c]:
                img.putpixel((x, y), PALETTE[c] + (255,))
    return img.resize((16 * scale, 16 * scale), Image.NEAREST)

if __name__ == '__main__':
    import os
    d = os.path.dirname(os.path.abspath(__file__))
    build(1).save(os.path.join(d, 'agent_16x16.png'))
    big = build(20)
    bg = Image.new('RGBA', big.size, (200, 208, 216, 255))
    bg.alpha_composite(big)
    bg.save(os.path.join(d, 'agent_16x16_preview.png'))
    build(1, GRID_SLIM).save(os.path.join(d, 'agent_slim_16x16.png'))
    big = build(20, GRID_SLIM)
    bg = Image.new('RGBA', big.size, (200, 208, 216, 255))
    bg.alpha_composite(big)
    bg.save(os.path.join(d, 'agent_slim_16x16_preview.png'))
