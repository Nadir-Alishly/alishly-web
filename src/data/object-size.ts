// World-size limits for objects in the /admin editor.
// Pure TypeScript with only erasable syntax and no DOM/three/Astro imports, so Node can import it
// directly (`node --test`).
//
// An object's world size is its native size (the model's bounding box, or the primitive's) x the model's
// `defaultScale` x the object's own `scale`. `LIMITS.minScale/maxScale` only bound that last multiplier;
// the limits here bound the result, so an object can neither vanish nor swallow the room. They are
// enforced by the editor when something is edited; saved objects outside them still load unchanged.

import { LIMITS, roundTo } from './scene.ts';
import type { Vec3 } from './scene.ts';

export const SIZE_LIMITS = {
	/** The largest side of an object, in metres, is never smaller than this... */
	minLargest: 0.25,
	/** ...nor bigger than this (this one applies to every side). */
	maxLargest: 8,
	/** Every side is at least this thick, so thin items (a rug) stay thin but never paper-thin. */
	minAxis: 0.01,
} as const;

export interface SizeClamp {
	/** The kept scale. Equals the input when `clamped` is false; otherwise rounded to 4 decimals (like `roundTo`). */
	scale: Vec3;
	/** True when a limit changed the value (beyond the editor's rounding). */
	clamped: boolean;
}

const EPS = 1e-9;
const TINY = 1e-12; // stands in for scales <= 0 so a collapsed value still has a direction
const STEP = 1e4; // `roundTo` keeps 4 decimals

// Directional rounding, tolerant of float noise (0.0003 * 1e4 = 2.9999999999999996).
const floor4 = (value: number) => Math.floor(value * STEP + EPS) / STEP + 0;
const ceil4 = (value: number) => Math.ceil(value * STEP - EPS) / STEP + 0;

const formatLength = (metres: number) =>
	metres < 1 ? `${Number((metres * 100).toPrecision(3))} cm` : `${Number(metres.toPrecision(3))} m`;

/** "Size limit: 25 cm – 8 m" */
export const SIZE_LIMIT_HINT = `Size limit: ${formatLength(SIZE_LIMITS.minLargest)} – ${formatLength(SIZE_LIMITS.maxLargest)}`;

const isVec3 = (value: unknown, ok: (n: number) => boolean): value is Vec3 =>
	Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n) && ok(n));

/** native x scale, per axis (the object's size in metres, ignoring rotation). */
export function worldSize(nativeSize: Vec3, scale: Vec3): Vec3 {
	return [nativeSize[0] * scale[0], nativeSize[1] * scale[1], nativeSize[2] * scale[2]];
}

/** Whether `scale` keeps the object inside the size limits (within `tolerance` metres). Handy for tests. */
export function withinSizeLimits(nativeSize: Vec3, scale: Vec3, tolerance = 1e-6): boolean {
	const size = worldSize(nativeSize, scale);
	const largest = Math.max(...size);
	return (
		size.every((s) => s >= SIZE_LIMITS.minAxis - tolerance && s <= SIZE_LIMITS.maxLargest + tolerance) &&
		largest >= SIZE_LIMITS.minLargest - tolerance
	);
}

/**
 * Keeps an object's world size inside SIZE_LIMITS by adjusting its scale.
 *
 * `nativeSize` is the unrotated bounding-box size already multiplied by the model's `defaultScale`
 * (so the world size is `nativeSize[i] * scale[i]`). `prevScale` is the scale before this edit, if known.
 *
 * Rules, in order:
 * 1. Every axis is capped at SIZE_LIMITS.maxLargest (8 m).
 * 2. If the largest side is then below SIZE_LIMITS.minLargest (25 cm), the axes that changed in this edit
 *    (|round4(scale) - round4(prevScale)| > 1e-9; all axes when there is no `prevScale`, or when none changed)
 *    are multiplied by one common factor so that their largest side becomes exactly 25 cm. A uniform shrink
 *    of any magnitude keeps its proportions; a single-axis edit does not inflate the other axes.
 * 2b. Afterwards every axis is raised to SIZE_LIMITS.minAxis (1 cm), so a thin axis (a rug) ends on the floor.
 * 3. The result stays inside [LIMITS.minScale, LIMITS.maxScale]; when that conflicts with the size limits
 *    (a native size below 0.2 mm or above 8 km) the multiplier range wins.
 * 4. The kept values are rounded to 4 decimals in the direction that keeps the limits (down for caps, up for
 *    floors), so the editor's `roundTo` afterwards cannot push them out again.
 *
 * An unknown native size (not an array of 3 finite numbers > 0) or a non-finite scale returns the input
 * unchanged with `clamped: false`. Otherwise `clamped` says whether the result differs from the input
 * beyond plain rounding; when it is false the input is returned as is.
 */
export function clampObjectScale(nativeSize: Vec3, scale: Vec3, prevScale?: Vec3): SizeClamp {
	const input: Vec3 = Array.isArray(scale) ? ([scale[0], scale[1], scale[2]] as Vec3) : scale;
	if (!isVec3(nativeSize, (n) => n > 0) || !isVec3(scale, () => true)) return { scale: input, clamped: false };
	const native = nativeSize;

	// Per-axis scale range that satisfies the size limits, inside the LIMITS multiplier range.
	const inLimits = (value: number) => Math.min(LIMITS.maxScale, Math.max(LIMITS.minScale, value));
	const hi = native.map((n) => inLimits(SIZE_LIMITS.maxLargest / n));
	const lo = native.map((n) => inLimits(SIZE_LIMITS.minAxis / n));

	// 1. cap every axis (the 1 cm floor comes last, so it cannot distort the common factor of step 2)
	const s = scale.map((v, i) => Math.min(hi[i], Math.max(TINY, v)));

	// 2. largest side too small: scale the axes changed by this edit up together
	const world = s.map((v, i) => v * native[i]);
	if (Math.max(...world) < SIZE_LIMITS.minLargest - EPS) {
		let changed = [0, 1, 2];
		if (isVec3(prevScale, () => true)) {
			const moved = changed.filter((i) => Math.abs(roundTo(scale[i]) - roundTo(prevScale[i])) > EPS);
			if (moved.length > 0) changed = moved;
		}
		const factor = SIZE_LIMITS.minLargest / Math.max(...changed.map((i) => world[i]));
		for (const i of changed) s[i] *= factor;
	}

	// then the per-axis floor and the multiplier range
	for (let i = 0; i < 3; i++) s[i] = Math.min(hi[i], Math.max(lo[i], s[i]));

	// 3./4. round without leaving the limits
	const kept = s.map((v, i) => {
		let r = roundTo(v);
		if (r > hi[i]) r = floor4(hi[i]);
		if (r < lo[i]) r = ceil4(lo[i]);
		return r;
	});
	const keptWorld = kept.map((v, i) => v * native[i]);
	if (Math.max(...keptWorld) < SIZE_LIMITS.minLargest - EPS) {
		// Rounding (to nearest) dropped the largest side just under the floor: lift that axis by one step.
		const j = keptWorld.indexOf(Math.max(...keptWorld));
		kept[j] = Math.min(ceil4(SIZE_LIMITS.minLargest / native[j]), floor4(hi[j]));
	}

	const clamped = kept.some((v, i) => Math.abs(v - roundTo(scale[i])) > EPS || Math.abs(s[i] - scale[i]) > EPS);
	return clamped ? { scale: [kept[0], kept[1], kept[2]], clamped } : { scale: input, clamped };
}
