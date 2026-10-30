#!/usr/bin/env bash
# Builds the room textures in public/textures/ from the 1k Poly Haven-style PNG sets (oak_wood_planks_*, white_stucco_*).
# Needs magick (ImageMagick with webp + jpeg) and python3 with numpy + PIL. Run from anywhere:
#   scripts/make-textures.sh <oak-src-dir> <stucco-src-dir>
# e.g. scripts/make-textures.sh "$HOME/Downloads/floor oak/textures" "$HOME/Downloads/wall/textures"
# Only diff + rough (oak) and diff + nor_gl (stucco) are used; AO, ARM, displacement and the oak normal are not.
set -euo pipefail
OAK="${1:?usage: make-textures.sh <oak-src-dir> <stucco-src-dir>}"
STUCCO="${2:?usage: make-textures.sh <oak-src-dir> <stucco-src-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../public/textures"
mkdir -p "$OUT/floor" "$OUT/wall"

# Oak albedo (sRGB; the room's tint is a material colour). Metadata and ICC stripped.
magick "$OAK/oak_wood_planks_diff_1k.png" -depth 8 -strip -quality 85 "$OUT/floor/oak-diff.jpg"
# Oak roughness: one channel (three reads G); the material's roughness scalar multiplies it.
magick "$OAK/oak_wood_planks_rough_1k.png" -depth 8 -colorspace Gray -strip -quality 90 "$OUT/floor/oak-rough.jpg"
# Stucco detail: luminance only, linear mean 0.95 (see stucco-detail.py).
python3 -I "$HERE/stucco-detail.py" "$STUCCO/white_stucco_diff_1k.png" "$OUT/wall/stucco-detail.jpg"
# Stucco normal (OpenGL): must be lossless, the grain is the signal. 512² keeps it at ~290 KB; B forced to 255.
magick "$STUCCO/white_stucco_nor_gl_1k.png" -depth 8 -strip -alpha off -resize 512x512 -channel B -evaluate set 100% +channel \
	-define webp:lossless=true -define webp:method=6 "$OUT/wall/stucco-normal.webp"

ls -l "$OUT/floor" "$OUT/wall"
