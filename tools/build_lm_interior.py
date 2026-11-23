"""Cut the LM interior reference renders (Parth Bhakta, supplied by the project owner; data-raw/lm_interior/) into
the flat panel skins used by src/render/lmInterior.ts. Crops are in the 1920x1080 source pixels.

  python3 tools/build_lm_interior.py  ->  public/models/lm_interior/*.jpg
"""
import os
from PIL import Image, ImageEnhance

SRC = 'data-raw/lm_interior'
OUT = 'public/models/lm_interior'
CROPS = {
    # name: (source, (x0, y0, x1, y1), output width)
    'panels12': ('front-panels.jpg', (495, 0, 1450, 705), 1024),     # flight panels 1 and 2 between the windows
    'panel3':   ('front-panels.jpg', (470, 705, 1475, 940), 1024),   # panel 3, the sloping shelf below them
    'lower':    ('bottom.jpg', (300, 300, 1700, 1080), 1024),        # DSKY, ACA/TTCA stations, floor
    'cdr_wall': ('right-panels.jpg', (380, 100, 1660, 740), 1024),   # circuit breakers on the commander's (left) side
    'lmp_wall': ('left-panels.jpg', (270, 20, 1720, 600), 1024),     # circuit breakers on the LM pilot's (right) side
    'aft':      ('back.jpg', (0, 0, 1920, 1080), 1024),              # aft bulkhead, stowage
    'ceiling':  ('wideangle.jpg', (300, 0, 1650, 210), 1024),        # overhead, docking hatch area
}
os.makedirs(OUT, exist_ok=True)
for name, (src, box, w) in CROPS.items():
    im = Image.open(f'{SRC}/{src}').convert('RGB').crop(box)
    h = round(w * im.height / im.width)
    im = im.resize((w, h), Image.LANCZOS)
    im = ImageEnhance.Brightness(im).enhance(1.25)  # the renders are dim; the sim lights the cabin with this skin alone
    im.save(f'{OUT}/{name}.jpg', quality=82, optimize=True)
    print(name, im.size)
