// The sun outside the window wall and the invisible shadow-only blocker above that wall.
// Pure TypeScript with only erasable syntax and no DOM/three/Astro imports (type-only import below), so Node can
// import it directly (`node --test`). room-core.ts turns the numbers into a light and a mesh.
import type { Box } from './room-window';
import type { Vec3 } from './scene';

/** The part of ROOM_DIMS the blocker depends on. */
export interface BlockerDims {
	half: number;
	inner: number;
	wallHeight: number;
}

// Low enough that the 3-high left wall shades the whole floor except the window's patch (rise/run 4/9 < 3/6.2;
// a steeper sun clears the wall top), and z <= 0 so no ray slips past the open front. Aims at the origin.
export const SUN_POSITION: Vec3 = [-9, 4, -0.8];

export const BLOCKER_TOP = 6; // shadow-only extension of the left wall; see `sunBlockerBox`

/**
 * How far the blocker reaches past the back wall's outer face (z = -half). The sun's z < 0 makes rays drift towards
 * -z as they head for -x: from the right wall's far end they are about 0.089 * 6.4 ≈ 0.57 beyond -half when they cross
 * the left wall (≈ -3.77). The margin keeps every ray aimed at something along the back wall behind the blocker, so no
 * sun leaks over the right wall: furniture up to wall height standing against it, and the right wall's top face
 * (which stays shaded in the sun's shadow map; the wall caps below only hide that on screen). Without it a wedge by
 * the corner is shaded and the rest is lit. Do not remove it because the caps exist. 0.9 leaves margin. No extension
 * is needed at +z: the sun's z <= 0 never drifts that way.
 */
export const BLOCKER_BACK_MARGIN = 0.9;

/**
 * Shadow-only extension of the left wall: same thickness (x -half … -inner), from the wall top up to BLOCKER_TOP,
 * along z from -(half + backMargin) to +half. The sun is low enough that the floor is shaded, but it would still
 * reach raised surfaces on the right over the wall top. Draws nothing; only casts into the sun's shadow map.
 */
export function sunBlockerBox(dims: BlockerDims, backMargin = BLOCKER_BACK_MARGIN, top = BLOCKER_TOP): Box {
	const { half, inner, wallHeight } = dims;
	return { min: [-half, wallHeight, -(half + backMargin)], max: [-inner, top, half] };
}

/** Slack added on top of the ray drift / rise that `sunBlockerFor` derives (world units). */
export const BLOCKER_DRIFT_SLACK = 0.3;
export const BLOCKER_RISE_SLACK = 0.2;

/**
 * The blocker for a sun at `sun` (a direction towards the sun from the origin, x < 0, y > 0, z <= 0). The back margin
 * and the top follow the direction: rays from anything in the room (x up to `half`) towards the sun cross the left wall
 * (x = -inner) displaced by `(half + inner) * |sz / sx|` towards -z and raised by `(half + inner) * sy / |sx|`. The
 * blocker must reach that far back and up, or sun leaks over the wall tops. Never smaller than the original box
 * (BLOCKER_BACK_MARGIN / BLOCKER_TOP), so the default sun gets exactly the box it always had. Valid for the sun domain of
 * SETTING_RANGES.sun (swept by tasks/2026-10-31-scene-settings/sun-domain.mts).
 */
export function sunBlockerFor(dims: BlockerDims, sun: Vec3): Box {
	const [sx, sy, sz] = sun;
	if (!(sx < 0) || !(sy > 0)) throw new RangeError('The sun must be outside the left wall (x < 0) and above the floor.');
	const run = dims.half + dims.inner;
	const margin = Math.max(BLOCKER_BACK_MARGIN, run * (Math.abs(sz) / -sx) + BLOCKER_DRIFT_SLACK);
	const top = Math.max(BLOCKER_TOP, dims.wallHeight + WALL_CAP_THICKNESS + run * (sy / -sx) + BLOCKER_RISE_SLACK);
	return sunBlockerBox(dims, margin, top);
}

/** Height of the light cap on each wall top. */
export const WALL_CAP_THICKNESS = 0.03;

/**
 * Thin boxes on the full top face of each wall (left: x -half … -inner, z -half … half; right: x -inner … half,
 * z -half … -inner, so they meet at x = -inner without overlapping). They exist only for looks: the blocker puts the
 * wall tops in the sun's shadow, the right one fully but the left one only by accident of the shadow bias, so without
 * caps the two tops would differ. room-core.ts draws the caps in the wall colour and neither casts nor receives
 * shadows on them, so both tops get the same light band whatever the sun's shadow map does. They do not replace the
 * blocker or its back margin, which still keep the sun off furniture and the rest of the room.
 */
export function wallCaps(dims: BlockerDims, thickness = WALL_CAP_THICKNESS): { left: Box; right: Box } {
	const { half, inner, wallHeight } = dims;
	const top = wallHeight + thickness;
	return {
		left: { min: [-half, wallHeight, -half], max: [-inner, top, half] },
		right: { min: [-inner, wallHeight, -half], max: [half, top, -inner] },
	};
}
