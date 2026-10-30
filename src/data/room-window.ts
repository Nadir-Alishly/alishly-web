// Geometry of the window in the left wall of every room: the opening, the wall pieces around it and the frame.
// Pure TypeScript with only erasable syntax and no DOM/three/Astro imports (type-only import below), so Node can
// import it directly (`node --test`). room-core.ts turns the boxes into meshes.
//
// All boxes are axis-aligned `{ min, max }` in room units. The left wall is the slab x = -half … -inner, the
// opening runs along z (horizontal) and y (vertical), and `inner` is the visible face of the wall.
import type { Vec3 } from './scene';

export interface Box {
	min: Vec3;
	max: Vec3;
}

/** The part of ROOM_DIMS the wall geometry depends on. */
export interface WallDims {
	half: number;
	inner: number;
	wallHeight: number;
}

/** The hole in the wall: z0 < z1 along the wall, y0 < y1 above the floor. */
export interface WindowOpening {
	z0: number;
	z1: number;
	y0: number;
	y1: number;
}

export interface WindowGrid {
	/** Panes along z. */
	cols: number;
	/** Panes along y. */
	rows: number;
	/** Thickness of the frame bars around the glazing. */
	frame: number;
	/** Thickness of the bars between panes. */
	muntin: number;
	/** Height of the sill ledge at the bottom of the opening. */
	sill: number;
	/** How far the frame sits inside the wall's outer and inner faces, so no face is coplanar with the wall's. */
	inset: number;
}

/** Same in every room, centred on the left wall (z = 0). */
export const WINDOW_OPENING: WindowOpening = { z0: -1.1, z1: 1.1, y0: 0.95, y1: 2.35 };

export const WINDOW_GRID: WindowGrid = { cols: 3, rows: 2, frame: 0.1, muntin: 0.05, sill: 0.07, inset: 0.04 };

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({
	min: [x0, y0, z0],
	max: [x1, y1, z1],
});

/** True when the opening is non-degenerate and lies inside the visible wall, `margin` away from every edge. */
export function windowOpeningFits(dims: WallDims, opening: WindowOpening, margin = 0.2): boolean {
	const { z0, z1, y0, y1 } = opening;
	return (
		z0 < z1 &&
		y0 < y1 &&
		z0 >= -dims.inner + margin &&
		z1 <= dims.half - margin &&
		y0 >= margin &&
		y1 <= dims.wallHeight - margin
	);
}

function assertFits(dims: WallDims, opening: WindowOpening) {
	if (!windowOpeningFits(dims, opening, 0)) throw new RangeError('The window opening does not fit in the wall.');
}

/**
 * The left wall (x -half … -inner, z -half … half, y 0 … wallHeight) as 4 boxes around the opening:
 * back jamb, front jamb, below the opening, above the opening. Together they cover the wall minus the
 * opening exactly, without overlapping. Throws a RangeError when the opening is not inside the wall.
 */
export function leftWallPieces(dims: WallDims, opening: WindowOpening = WINDOW_OPENING): Box[] {
	assertFits(dims, opening);
	const { half, inner, wallHeight: top } = dims;
	const { z0, z1, y0, y1 } = opening;
	return [
		box(-half, 0, -half, -inner, top, z0),
		box(-half, 0, z1, -inner, top, half),
		box(-half, 0, z0, -inner, y0, z1),
		box(-half, y1, z0, -inner, top, z1),
	];
}

export interface WindowFrame {
	/** Ledge that fills the bottom of the opening over the whole wall thickness. */
	sill: Box;
	/** Bottom, top, back and front bars around the glazing; they tile the opening minus sill and glazing. */
	frame: Box[];
	/** Bars between panes: full-height vertical ones, horizontal ones cut into segments between them. */
	muntins: Box[];
	/** The glazed area inside the frame, plus the x position of the glowing pane within the wall's thickness. */
	glazing: { z0: number; z1: number; y0: number; y1: number; paneX: number };
}

/**
 * Frame, muntins and sill for the opening, all inside the wall's thickness (x ≤ -inner), so nothing sticks
 * into the room and ROOM_BOUNDS stays valid. None of the boxes overlap each other or the wall pieces.
 */
export function windowFrame(
	dims: WallDims,
	opening: WindowOpening = WINDOW_OPENING,
	grid: WindowGrid = WINDOW_GRID,
): WindowFrame {
	assertFits(dims, opening);
	const { half, inner } = dims;
	const { z0, z1, y0, y1 } = opening;
	const { cols, rows, frame: f, muntin: m, sill: s, inset } = grid;
	const fx0 = -half + inset;
	const fx1 = -inner - inset;
	const mx0 = (fx0 + fx1) / 2 - m / 2;
	const mx1 = (fx0 + fx1) / 2 + m / 2;

	const gy0 = y0 + s + f;
	const gy1 = y1 - f;
	const gz0 = z0 + f;
	const gz1 = z1 - f;

	const sill = box(-half, y0, z0, -inner, y0 + s, z1);
	const frame = [
		box(fx0, y0 + s, z0, fx1, gy0, z1), // bottom bar, on the sill
		box(fx0, gy1, z0, fx1, y1, z1), // top bar
		box(fx0, gy0, z0, fx1, gy1, gz0), // back bar
		box(fx0, gy0, gz1, fx1, gy1, z1), // front bar
	];

	const muntins: Box[] = [];
	const cuts: number[] = [gz0];
	for (let c = 1; c < cols; c++) {
		const z = gz0 + ((gz1 - gz0) * c) / cols;
		muntins.push(box(mx0, gy0, z - m / 2, mx1, gy1, z + m / 2));
		cuts.push(z - m / 2, z + m / 2);
	}
	cuts.push(gz1);
	for (let r = 1; r < rows; r++) {
		const y = gy0 + ((gy1 - gy0) * r) / rows;
		for (let i = 0; i < cuts.length; i += 2) {
			muntins.push(box(mx0, y - m / 2, cuts[i], mx1, y + m / 2, cuts[i + 1]));
		}
	}

	return {
		sill,
		frame,
		muntins,
		glazing: { z0: gz0, z1: gz1, y0: gy0, y1: gy1, paneX: -half + inset / 2 },
	};
}
