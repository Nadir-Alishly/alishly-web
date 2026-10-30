// Unit tests for src/data/room-window.ts (window opening, wall pieces, frame). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	leftWallPieces, windowFrame, windowOpeningFits, WINDOW_OPENING, WINDOW_GRID,
	type Box, type WindowOpening, type WindowGrid,
} from '../src/data/room-window.ts';
import { ROOM_DIMS } from '../src/data/scene.ts';

const EPS = 1e-9;
const D = ROOM_DIMS;
const O = WINDOW_OPENING;
const G = WINDOW_GRID;

const vol = (b: Box) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
const sizes = (b: Box) => [0, 1, 2].map((i) => b.max[i] - b.min[i]);
/** Overlap volume of two boxes (0 when they only touch). */
const overlap = (a: Box, b: Box) =>
	[0, 1, 2].reduce((v, i) => v * Math.max(0, Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i])), 1);
const inside = (b: Box, outer: Box, eps = EPS) =>
	[0, 1, 2].every((i) => b.min[i] >= outer.min[i] - eps && b.max[i] <= outer.max[i] + eps);
const box = (min: [number, number, number], max: [number, number, number]): Box => ({ min, max });

const WALL = box([-D.half, 0, -D.half], [-D.inner, D.wallHeight, D.half]);
const HOLE = box([-D.half, O.y0, O.z0], [-D.inner, O.y1, O.z1]);

/** Coordinate-compression grid: every cell between all box edges, with how many of `boxes` cover its centre. */
function coverage(boxes: Box[], extent: Box) {
	const axes = [0, 1, 2].map((i) => {
		const set = new Set<number>([extent.min[i], extent.max[i]]);
		for (const b of boxes) { set.add(b.min[i]); set.add(b.max[i]); }
		return [...set].filter((v) => v >= extent.min[i] - EPS && v <= extent.max[i] + EPS).sort((a, b) => a - b);
	});
	const cells: { vol: number; count: number; centre: [number, number, number] }[] = [];
	for (let x = 0; x < axes[0].length - 1; x++)
		for (let y = 0; y < axes[1].length - 1; y++)
			for (let z = 0; z < axes[2].length - 1; z++) {
				const lo = [axes[0][x], axes[1][y], axes[2][z]];
				const hi = [axes[0][x + 1], axes[1][y + 1], axes[2][z + 1]];
				const centre = lo.map((v, i) => (v + hi[i]) / 2) as [number, number, number];
				const count = boxes.filter((b) => [0, 1, 2].every((i) => centre[i] > b.min[i] && centre[i] < b.max[i])).length;
				cells.push({ vol: (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]), count, centre });
			}
	return cells;
}

test('constants: opening sits on the wall centre and the grid is the planned 3x2', () => {
	assert.equal(O.z0, -O.z1, 'opening is centred on z = 0');
	assert.ok(O.z0 < O.z1 && O.y0 < O.y1);
	assert.equal(G.cols, 3);
	assert.equal(G.rows, 2);
	assert.ok(G.muntin < G.frame, 'muntins are thinner than the frame bars');
});

test('default opening fits the wall with margin', () => {
	assert.equal(windowOpeningFits(D, O), true);
	assert.ok(O.z0 >= -D.inner + 0.2 && O.z1 <= D.half - 0.2);
	assert.ok(O.y0 >= 0.2 && O.y1 <= D.wallHeight - 0.2);
});

test('windowOpeningFits rejects degenerate, reversed and out-of-wall openings', () => {
	const ok = O;
	const bad: [string, WindowOpening][] = [
		['zero width', { ...ok, z1: ok.z0 }],
		['reversed z', { ...ok, z0: ok.z1, z1: ok.z0 }],
		['zero height', { ...ok, y1: ok.y0 }],
		['reversed y', { ...ok, y0: ok.y1, y1: ok.y0 }],
		['back edge past the inner face', { ...ok, z0: -D.inner - 0.1 }],
		['back edge inside the margin', { ...ok, z0: -D.inner + 0.1 }],
		['front edge past the wall end', { ...ok, z1: D.half + 0.1 }],
		['front edge inside the margin', { ...ok, z1: D.half - 0.1 }],
		['below the floor', { ...ok, y0: -0.1 }],
		['touches the floor margin', { ...ok, y0: 0.1 }],
		['above the wall top', { ...ok, y1: D.wallHeight + 0.1 }],
		['inside the top margin', { ...ok, y1: D.wallHeight - 0.1 }],
		['NaN edge', { ...ok, z0: NaN }],
	];
	for (const [name, o] of bad) assert.equal(windowOpeningFits(D, o), false, name);
});

test('windowOpeningFits: margin parameter is honoured', () => {
	const tight: WindowOpening = { z0: -D.inner + 0.05, z1: 1, y0: 0.05, y1: 2 };
	assert.equal(windowOpeningFits(D, tight), false, 'default margin 0.2');
	assert.equal(windowOpeningFits(D, tight, 0), true, 'margin 0');
	assert.equal(windowOpeningFits(D, tight, 0.05), true, 'margin exactly on the edge');
	assert.equal(windowOpeningFits(D, tight, 0.06), false);
});

test('leftWallPieces: 4 boxes, each non-empty and inside the wall', () => {
	const pieces = leftWallPieces(D);
	assert.equal(pieces.length, 4);
	for (const p of pieces) {
		assert.ok(sizes(p).every((s) => s > 0), 'positive size on every axis');
		assert.ok(inside(p, WALL), 'inside the wall extents');
	}
});

test('leftWallPieces: no two pieces overlap', () => {
	const pieces = leftWallPieces(D);
	for (let i = 0; i < pieces.length; i++)
		for (let j = i + 1; j < pieces.length; j++)
			assert.ok(overlap(pieces[i], pieces[j]) < EPS, `pieces ${i} and ${j} overlap`);
});

test('leftWallPieces: volume is exactly wall minus opening', () => {
	const sum = leftWallPieces(D).reduce((s, p) => s + vol(p), 0);
	assert.ok(Math.abs(sum - (vol(WALL) - vol(HOLE))) < 1e-9, `${sum} vs ${vol(WALL) - vol(HOLE)}`);
});

test('leftWallPieces: no piece intrudes into the opening', () => {
	for (const p of leftWallPieces(D)) assert.ok(overlap(p, HOLE) < EPS);
});

test('leftWallPieces: every point of the wall outside the opening is covered exactly once, the opening not at all', () => {
	const cells = coverage(leftWallPieces(D), WALL);
	const holeCells = cells.filter((c) => c.centre[1] > O.y0 && c.centre[1] < O.y1 && c.centre[2] > O.z0 && c.centre[2] < O.z1);
	assert.ok(holeCells.length > 0);
	for (const c of cells) {
		const inHole = holeCells.includes(c);
		assert.equal(c.count, inHole ? 0 : 1, `cell at ${c.centre} covered ${c.count}x`);
	}
});

test('leftWallPieces: pieces keep the full wall thickness and span the wall height/length at the edges', () => {
	const pieces = leftWallPieces(D);
	for (const p of pieces) {
		assert.equal(p.min[0], -D.half);
		assert.equal(p.max[0], -D.inner);
	}
	assert.equal(Math.min(...pieces.map((p) => p.min[1])), 0);
	assert.equal(Math.max(...pieces.map((p) => p.max[1])), D.wallHeight);
	assert.equal(Math.min(...pieces.map((p) => p.min[2])), -D.half);
	assert.equal(Math.max(...pieces.map((p) => p.max[2])), D.half);
});

test('leftWallPieces: works for other valid openings and stays an exact tiling', () => {
	for (const o of [
		{ z0: -2, z1: 2, y0: 0.5, y1: 2.5 },
		{ z0: -0.3, z1: 0.3, y0: 1, y1: 1.4 },
		{ z0: -3.2 + 0.4, z1: -1, y0: 0.2, y1: 2.8 },
	]) {
		const pieces = leftWallPieces(D, o);
		const hole = box([-D.half, o.y0, o.z0], [-D.inner, o.y1, o.z1]);
		const sum = pieces.reduce((s, p) => s + vol(p), 0);
		assert.ok(Math.abs(sum - (vol(WALL) - vol(hole))) < 1e-9);
		for (let i = 0; i < pieces.length; i++)
			for (let j = i + 1; j < pieces.length; j++) assert.ok(overlap(pieces[i], pieces[j]) < EPS);
	}
});

test('leftWallPieces / windowFrame throw RangeError for an opening outside the wall', () => {
	const bad: WindowOpening[] = [
		{ z0: 1, z1: -1, y0: 1, y1: 2 },
		{ z0: -1, z1: 1, y0: 2, y1: 1 },
		{ z0: -1, z1: 1, y0: 1, y1: D.wallHeight + 0.5 },
		{ z0: -1, z1: 1, y0: -0.5, y1: 1 },
		{ z0: -D.inner - 1, z1: 0, y0: 1, y1: 2 },
		{ z0: 0, z1: D.half + 1, y0: 1, y1: 2 },
	];
	for (const o of bad) {
		assert.throws(() => leftWallPieces(D, o), RangeError, JSON.stringify(o));
		assert.throws(() => windowFrame(D, o), RangeError, JSON.stringify(o));
	}
});

test('leftWallPieces: an opening exactly flush with the wall edge (margin 0) is accepted', () => {
	// The throw threshold is margin 0; flush openings produce zero-size pieces, which is allowed by the contract.
	assert.doesNotThrow(() => leftWallPieces(D, { z0: -D.inner, z1: 1, y0: 0.5, y1: 2 }));
});

test('windowFrame: structure of the default frame (sill, 4 bars, 2 vertical + 3 horizontal muntin boxes)', () => {
	const f = windowFrame(D);
	assert.equal(f.frame.length, 4);
	// (cols-1) full-height verticals + (rows-1) horizontals cut into `cols` segments
	assert.equal(f.muntins.length, (G.cols - 1) + (G.rows - 1) * G.cols);
	assert.equal(f.muntins.length, 5);
});

test('windowFrame: every part has positive size', () => {
	const f = windowFrame(D);
	for (const b of [f.sill, ...f.frame, ...f.muntins]) assert.ok(sizes(b).every((s) => s > 0), JSON.stringify(b));
});

test('windowFrame: all parts lie inside the opening and within the wall thickness on the x <= -3 side', () => {
	const f = windowFrame(D);
	for (const b of [f.sill, ...f.frame, ...f.muntins]) {
		assert.ok(inside(b, HOLE), `${JSON.stringify(b)} not inside the opening`);
		assert.ok(b.min[0] >= -D.half - EPS && b.max[0] <= -D.inner + EPS, 'inside the wall slab on x');
		assert.ok(b.max[0] <= -3 + EPS, 'never reaches into the room (x <= -3)');
	}
});

test('windowFrame: frame/muntin/sill parts do not overlap each other or the wall pieces', () => {
	const f = windowFrame(D);
	const parts = [f.sill, ...f.frame, ...f.muntins, ...leftWallPieces(D)];
	for (let i = 0; i < parts.length; i++)
		for (let j = i + 1; j < parts.length; j++) assert.ok(overlap(parts[i], parts[j]) < EPS, `parts ${i} and ${j} overlap`);
});

test('windowFrame: sill is at the bottom of the opening and spans its width', () => {
	const f = windowFrame(D);
	assert.equal(f.sill.min[1], O.y0);
	assert.ok(Math.abs(f.sill.max[1] - (O.y0 + G.sill)) < EPS);
	assert.equal(f.sill.min[2], O.z0);
	assert.equal(f.sill.max[2], O.z1);
});

test('windowFrame: bars sit on the sill and tile the border around the glazing exactly', () => {
	const f = windowFrame(D);
	const g = f.glazing;
	assert.ok(Math.abs(g.y0 - (O.y0 + G.sill + G.frame)) < EPS);
	assert.ok(Math.abs(g.y1 - (O.y1 - G.frame)) < EPS);
	assert.ok(Math.abs(g.z0 - (O.z0 + G.frame)) < EPS);
	assert.ok(Math.abs(g.z1 - (O.z1 - G.frame)) < EPS);
	// Frame bars together cover (opening minus sill) in y/z projection, minus the glazing rectangle.
	const area = (b: Box) => (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
	const total = (O.y1 - (O.y0 + G.sill)) * (O.z1 - O.z0);
	const glazingArea = (g.y1 - g.y0) * (g.z1 - g.z0);
	const barArea = f.frame.reduce((s, b) => s + area(b), 0);
	assert.ok(Math.abs(barArea - (total - glazingArea)) < 1e-9, `${barArea} vs ${total - glazingArea}`);
	assert.ok(Math.abs(f.frame[0].min[1] - (O.y0 + G.sill)) < EPS, 'bottom bar starts on top of the sill');
});

test('windowFrame: muntins lie within the glazing rectangle and divide it into cols x rows panes', () => {
	const f = windowFrame(D);
	const g = f.glazing;
	const glaze = box([-D.half, g.y0, g.z0], [-D.inner, g.y1, g.z1]);
	for (const m of f.muntins) assert.ok(inside(m, glaze), JSON.stringify(m));
	// Open (pane) area = glazing minus muntins, projected on y/z. Pane count = cols * rows.
	const verticals = f.muntins.filter((m) => m.min[1] === g.y0 && m.max[1] === g.y1);
	const horizontals = f.muntins.filter((m) => !(m.min[1] === g.y0 && m.max[1] === g.y1));
	assert.equal(verticals.length, G.cols - 1);
	assert.equal(horizontals.length, (G.rows - 1) * G.cols);
	// Vertical muntins evenly split the glazing width into `cols` equal panes.
	const centres = verticals.map((m) => (m.min[2] + m.max[2]) / 2).sort((a, b) => a - b);
	centres.forEach((c, i) => assert.ok(Math.abs(c - (g.z0 + ((g.z1 - g.z0) * (i + 1)) / G.cols)) < EPS));
	// Horizontal muntins sit at evenly spaced heights, each row's segments tile the width between the verticals.
	const ys = [...new Set(horizontals.map((m) => +((m.min[1] + m.max[1]) / 2).toFixed(9)))].sort((a, b) => a - b);
	assert.equal(ys.length, G.rows - 1);
	ys.forEach((y, i) => assert.ok(Math.abs(y - (g.y0 + ((g.y1 - g.y0) * (i + 1)) / G.rows)) < 1e-8));
	const glazingArea = (g.y1 - g.y0) * (g.z1 - g.z0);
	const mArea = f.muntins.reduce((s, m) => s + (m.max[1] - m.min[1]) * (m.max[2] - m.min[2]), 0);
	const expected = (G.cols - 1) * G.muntin * (g.y1 - g.y0) + (G.rows - 1) * G.muntin * ((g.z1 - g.z0) - (G.cols - 1) * G.muntin);
	assert.ok(Math.abs(mArea - expected) < 1e-9, `${mArea} vs ${expected}`);
	assert.ok(mArea < glazingArea / 2, 'panes are mostly open glass');
});

test('windowFrame: glazing metadata is consistent (x positions inside the wall, rect inside the opening)', () => {
	const g = windowFrame(D).glazing;
	assert.ok(g.z0 > O.z0 && g.z1 < O.z1 && g.y0 > O.y0 && g.y1 < O.y1);
	assert.ok(g.z0 < g.z1 && g.y0 < g.y1);
	for (const x of [g.glassX, g.skyX]) assert.ok(x >= -D.half && x <= -D.inner, `x ${x} within the wall thickness`);
	assert.ok(g.skyX < g.glassX, 'sky pane is behind (outside) the glass');
});

test('windowFrame: frame x-extent is inset from both wall faces (no coplanar faces)', () => {
	const f = windowFrame(D);
	for (const b of [...f.frame, ...f.muntins]) {
		assert.ok(b.min[0] > -D.half, 'not coplanar with the outer face');
		assert.ok(b.max[0] < -D.inner, 'not coplanar with the inner face');
	}
});

test('windowFrame: custom grids stay valid and consistent', () => {
	const grids: WindowGrid[] = [
		{ ...G, cols: 2, rows: 2 },
		{ ...G, cols: 3, rows: 3 },
		{ ...G, cols: 1, rows: 1 },
		{ cols: 4, rows: 1, frame: 0.08, muntin: 0.03, sill: 0.05, inset: 0.02 },
	];
	for (const grid of grids) {
		const f = windowFrame(D, O, grid);
		assert.equal(f.muntins.length, (grid.cols - 1) + (grid.rows - 1) * grid.cols);
		const parts = [f.sill, ...f.frame, ...f.muntins];
		for (const b of parts) assert.ok(inside(b, HOLE) && sizes(b).every((s) => s > 0));
		for (let i = 0; i < parts.length; i++)
			for (let j = i + 1; j < parts.length; j++) assert.ok(overlap(parts[i], parts[j]) < EPS, `grid ${JSON.stringify(grid)}: ${i}/${j}`);
	}
});

test('helper does not mutate its constants or inputs', () => {
	const o = JSON.stringify(O), g = JSON.stringify(G), d = JSON.stringify(D);
	leftWallPieces(D);
	windowFrame(D);
	windowOpeningFits(D, O);
	assert.equal(JSON.stringify(O), o);
	assert.equal(JSON.stringify(G), g);
	assert.equal(JSON.stringify(D), d);
});
