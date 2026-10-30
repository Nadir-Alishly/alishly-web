# Luminance-only detail map from the stucco albedo, for scripts/make-textures.sh (run with `python3 -I`).
# Usage: python3 -I scripts/stucco-detail.py <white_stucco_diff_1k.png> <out.jpg>
# Drops the source's ~4% warm cast, stretches the grain's contrast by CONTRAST about its mean (the grain is far finer than a
# screen pixel at the default view, so the source's own contrast averages out to nothing), and scales the result so its
# linear-light mean is MEAN after texels above 1 are clipped. The room colour times 1 / MEAN (WALL_GAIN in
# src/data/room-palette.ts) is then the visible wall colour.
import sys

import numpy as np
from PIL import Image

MEAN = 0.95
CONTRAST = 1.5

src, dst = sys.argv[1], sys.argv[2]
a = np.asarray(Image.open(src).convert("RGB")).astype(float) / 255
lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
y = lin @ np.array([0.2126, 0.7152, 0.0722])
y /= y.mean()
y = np.clip(1 + CONTRAST * (y - 1), 0, None)
lo, hi = 0.5, 2.0
for _ in range(60):  # bisect the scale: the clipped mean grows with it
    scale = (lo + hi) / 2
    lo, hi = (scale, hi) if np.clip(y * scale, 0, 1).mean() < MEAN else (lo, scale)
y = np.clip(y * scale, 0, 1)
enc = np.where(y <= 0.0031308, y * 12.92, 1.055 * y ** (1 / 2.4) - 0.055)
Image.fromarray((enc * 255 + 0.5).astype(np.uint8)).save(dst, quality=88)
