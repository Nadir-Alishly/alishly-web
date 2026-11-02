// The window wood (frame, sill and muntins): the world length one uv unit stands for, how the admin's `window` settings
// become a texture transform, and the colour fallback while the dark-wood maps are not there. Pure TypeScript, no imports,
// so Node can test it. room-core.ts applies the result through its shared mapTransform.
import type { WindowSettings } from './scene-settings.ts';

/** The window bars get world-space uvs at this tile (see room-uv.ts); the `tile` setting then scales it as a repeat. */
export const WINDOW_UV_TILE = 1;

/** Mean linear-light albedo of public/textures/window/dark-wood-diff.jpg: the colour of the bars while the map is missing. */
export const DARK_WOOD_LINEAR: readonly [number, number, number] = [0.1134, 0.0251, 0.0095];

export interface MapTransform {
	/** Texture repeat (both axes). */
	repeat: number;
	/** Degrees. */
	rotation: number;
	/** Tiles. */
	offsetX: number;
	offsetY: number;
}

/** `tile` is world units per texture repeat; the uvs are already world-space at WINDOW_UV_TILE. */
export function windowMapTransform(w: Pick<WindowSettings, 'tile' | 'rotation' | 'offsetX' | 'offsetY'>): MapTransform {
	return { repeat: WINDOW_UV_TILE / w.tile, rotation: w.rotation, offsetX: w.offsetX, offsetY: w.offsetY };
}

/** The longest axis of a box (0 x, 1 y, 2 z); ties go to the earlier axis. Which way a bar's grain should run. */
export function longAxisOf(min: readonly number[], max: readonly number[]): 0 | 1 | 2 {
	const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	return size[1] > size[0] && size[1] >= size[2] ? 1 : size[2] > size[0] ? 2 : 0;
}
