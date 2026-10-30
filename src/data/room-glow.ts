// Geometry of the fake window glow: the halo on the wall around the opening and the light pool on the floor where
// the sun comes in. Pure TypeScript with only erasable syntax and no DOM/three/Astro imports (type-only imports
// below), so Node can import it directly (`node --test`). room-core.ts turns the numbers into textured planes.
import type { WallDims, WindowOpening } from './room-window';
import type { Vec3 } from './scene';

/** How far the halo reaches beyond the opening on each side, world units. */
export const HALO_SPREAD = 1.25;
/** How far the floor pool reaches beyond the sun's patch on every side, world units. */
export const POOL_SPREAD = 0.6;

export interface Rect {
	z0: number;
	z1: number;
	y0: number;
	y1: number;
}

/**
 * The halo plane on the visible face of the left wall: the opening grown by `spread`, cut off at the wall's visible
 * extent (z from -inner, floor, wall top) so nothing sticks out past the wall. `hole` is the opening as fractions
 * (0..1, y from the bottom) of the returned rect, so the texture can leave it clear.
 */
export function haloRect(
	dims: WallDims,
	opening: WindowOpening,
	spread = HALO_SPREAD,
): { rect: Rect; hole: Rect } {
	const rect: Rect = {
		z0: Math.max(-dims.inner, opening.z0 - spread),
		z1: Math.min(dims.half, opening.z1 + spread),
		y0: Math.max(0, opening.y0 - spread),
		y1: Math.min(dims.wallHeight, opening.y1 + spread),
	};
	const w = rect.z1 - rect.z0;
	const h = rect.y1 - rect.y0;
	const hole: Rect = {
		z0: (opening.z0 - rect.z0) / w,
		z1: (opening.z1 - rect.z0) / w,
		y0: (opening.y0 - rect.y0) / h,
		y1: (opening.y1 - rect.y0) / h,
	};
	return { rect, hole };
}

/**
 * Where the sun's light through the opening lands on the floor (y = 0): the opening's four corners projected along
 * the ray from the sun, taken at the wall's visible face. Corners in order (y0,z0) (y0,z1) (y1,z1) (y1,z0), as
 * [x, z] pairs. The sun must be outside the wall (x < 0) and above the floor (y > 0).
 */
export function sunPatch(
	dims: WallDims,
	opening: WindowOpening,
	sun: Vec3,
): [number, number][] {
	const [sx, sy, sz] = sun;
	if (!(sy > 0)) throw new RangeError('The sun must be above the floor.');
	const at = (y: number, z: number): [number, number] => [-dims.inner - (sx * y) / sy, z - (sz * y) / sy];
	return [
		at(opening.y0, opening.z0),
		at(opening.y0, opening.z1),
		at(opening.y1, opening.z1),
		at(opening.y1, opening.z0),
	];
}

/** Axis-aligned bounds `{ x0, x1, z0, z1 }` of a polygon grown by `margin` on every side. */
export function polygonBounds(points: readonly (readonly [number, number])[], margin = 0) {
	const xs = points.map((p) => p[0]);
	const zs = points.map((p) => p[1]);
	return {
		x0: Math.min(...xs) - margin,
		x1: Math.max(...xs) + margin,
		z0: Math.min(...zs) - margin,
		z1: Math.max(...zs) + margin,
	};
}
