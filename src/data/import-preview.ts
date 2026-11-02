// Pure helpers of the admin's live import preview (a ghost of the model being imported, shown in the room while the
// import form is open): which default scale the form's text means, what object scale a placed copy would get after the
// size limits, and which floor spot "Add to room" would use. Pure TypeScript, no DOM/three imports, so Node can test it.
import { clampObjectScale } from './object-size.ts';
import { LIMITS, roundTo } from './scene.ts';
import type { Vec3 } from './scene.ts';

/**
 * The model's `defaultScale` the form's text stands for: the number rounded to 4 significant digits (what Add stores),
 * kept inside LIMITS. Null while the text is empty or not a positive number (the preview then keeps what it shows).
 */
export function previewDefaultScale(text: string): number | null {
	if (text.trim() === '') return null;
	const value = Number(text);
	if (!Number.isFinite(value) || value <= 0) return null;
	const clamped = Math.min(LIMITS.maxScale, Math.max(LIMITS.minScale, value));
	return Number(clamped.toPrecision(4));
}

/**
 * The scale a placed object of this model would hold: [1, 1, 1], pushed inside the object size limits like the editor does
 * for a new object (`native` is the model's size in its own units; its world size is native × defaultScale × scale).
 * Without a known size nothing can be clamped.
 */
export function previewObjectScale(native: Vec3 | null, defaultScale: number): { scale: Vec3; clamped: boolean } {
	if (!native) return { scale: [1, 1, 1], clamped: false };
	return clampObjectScale([native[0] * defaultScale, native[1] * defaultScale, native[2] * defaultScale], [1, 1, 1]);
}

/**
 * The floor spot (x, z) a new object takes: the first of `spots` with nothing within 0.6 m of it, else the first spot.
 * Shared by "Add to room" and the preview so the ghost is where the object would land.
 */
export function pickSpot(spots: readonly (readonly [number, number])[], positions: readonly Vec3[]): [number, number] {
	const free = spots.find(([x, z]) => positions.every((p) => Math.hypot(p[0] - x, p[2] - z) > 0.6));
	const [x, z] = free ?? spots[0];
	return [x, z];
}

/** The ghost's opacity multiplier (its materials keep their own alpha below this). */
export const GHOST_OPACITY = 0.45;

/** One material's opacity under the ghost: scaled, never above the material's own opacity. */
export const ghostOpacity = (own: number): number => roundTo(Math.min(own, 1) * GHOST_OPACITY);
