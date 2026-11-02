#!/usr/bin/env bash
# Builds the room textures in public/textures/ from the 1k Poly Haven-style PNG sets (oak_wood_planks_*, white_stucco_*, dark_wood_*).
# Needs magick (ImageMagick with webp + jpeg) and python3 with numpy + PIL. Run from anywhere:
#   scripts/make-textures.sh <oak-src-dir> <stucco-src-dir> [<dark-wood-src-dir>]
#   scripts/make-textures.sh --window-only <dark-wood-src-dir>      (only public/textures/window/, leaves the rest alone)
# e.g. scripts/make-textures.sh "$HOME/Downloads/floor oak/textures" "$HOME/Downloads/wall/textures" "$HOME/Downloads/dark_wood_1k/textures"
# Only diff + rough (oak, dark wood) and diff + nor_gl (stucco) are used; AO, ARM, displacement and the other normals are not.
set -euo pipefail
USAGE="usage: make-textures.sh <oak-src-dir> <stucco-src-dir> [<dark-wood-src-dir>] | --window-only <dark-wood-src-dir>"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../public/textures"

window() {
	local src="$1"
	mkdir -p "$OUT/window"
	# Window wood albedo (sRGB; 512² is plenty for thin bars). The 16-bit source goes to 8 bit; metadata and ICC stripped.
	magick "$src/dark_wood_diff_1k.png" -depth 8 -strip -resize 512x512 -quality 85 "$OUT/window/dark-wood-diff.jpg"
	# Window wood roughness: one channel (three reads G); no normal map for the window.
	magick "$src/dark_wood_rough_1k.png" -depth 8 -colorspace Gray -strip -resize 512x512 -quality 90 "$OUT/window/dark-wood-rough.jpg"
	ls -l "$OUT/window"
}

if [ "${1:-}" = "--window-only" ]; then
	window "${2:?$USAGE}"
	exit 0
fi

OAK="${1:?$USAGE}"
STUCCO="${2:?$USAGE}"
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
if [ -n "${3:-}" ]; then window "$3"; fi
