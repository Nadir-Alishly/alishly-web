// Unit tests for barUvs() in src/data/room-uv.ts: the window frame, sill and muntin uvs (world space, grain along each bar).
// The geometry is three's real BoxGeometry, translated like room-core.ts's barBox(). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { boxUvs, barUvs } from '../src/data/room-uv.ts';
import { longAxisOf } from '../src/data/window-wood.ts';

const EPS = 1e-5; // BoxGeometry stores float32 positions
type Axis = 0 | 1 | 2;

/** A bar of the given min/max corners, as room-core builds it: a BoxGeometry translated into place. */
function bar(min: [number, number, number], max: [number, number, number]) {
	const size = [0, 1, 2].map((i) => max[i] - min[i]);
	const centre = [0, 1, 2].map((i) => (max[i] + min[i]) / 2);
	const g = new BoxGeometry(size[0], size[1], size[2]).translate(centre[0], centre[1], centre[2]);
	return { pos: g.attributes.position.array, nor: g.attributes.normal.array, index: g.index!.array };
}

// Which world axis is a face's v, by its dominant normal axis (x-normal and z-normal faces: v = y; y-normal: v = z).
const vAxisOf = (n: number[]): Axis => {
	const [ax, ay, az] = n.map(Math.abs);
	if (ax >= ay && ax >= az) return 1;
	if (az >= ay) return 1;
	return 2;
};

const faceNormalAxisOf = (n: number[]): Axis => {
	const [ax, ay, az] = n.map(Math.abs);
	return ax >= ay && ax >= az ? 0 : az >= ay ? 2 : 1;
};

test('barUvs: one uv pair per vertex, the same length as boxUvs', () => {
	const g = bar([0, 0, 0], [0.1, 2.4, 0.1]);
	for (const longAxis of [0, 1, 2] as const) {
		const a = barUvs(g.pos, g.nor, 1, longAxis);
		assert.equal(a.length, (g.pos.length / 3) * 2, `longAxis ${longAxis}`);
		assert.equal(a.length, boxUvs(g.pos, g.nor, 1).length);
		assert.ok(a.every(Number.isFinite), 'no NaN or infinity');
	}
});

test('barUvs: a face whose v axis is not the long axis keeps exactly its boxUvs (world space, unchanged)', () => {
	const g = bar([0, 0, 0], [0.1, 2.4, 0.1]); // tall muntin: long axis y
	const plain = boxUvs(g.pos, g.nor, 1);
	const turned = barUvs(g.pos, g.nor, 1, 1);
	for (let v = 0; v < g.pos.length / 3; v++) {
		const n = [g.nor[v * 3], g.nor[v * 3 + 1], g.nor[v * 3 + 2]];
		if (vAxisOf(n) === 1) continue; // handled by the next test
		assert.equal(turned[v * 2], plain[v * 2], `vertex ${v} u`);
		assert.equal(turned[v * 2 + 1], plain[v * 2 + 1], `vertex ${v} v`);
	}
});

test('barUvs: on a face whose v is the long axis the uv is turned a quarter: (u, v) -> (v, -u), not mirrored', () => {
	const g = bar([0, 0, 0], [0.1, 2.4, 0.1]); // long axis y: the x- and z-normal faces have v = y
	const plain = boxUvs(g.pos, g.nor, 1);
	const turned = barUvs(g.pos, g.nor, 1, 1);
	let checked = 0;
	for (let v = 0; v < g.pos.length / 3; v++) {
		const n = [g.nor[v * 3], g.nor[v * 3 + 1], g.nor[v * 3 + 2]];
		if (vAxisOf(n) !== 1) continue;
		checked++;
		assert.ok(Math.abs(turned[v * 2] - plain[v * 2 + 1]) < EPS, `vertex ${v}: u' = v`);
		assert.ok(Math.abs(turned[v * 2 + 1] + plain[v * 2]) < EPS, `vertex ${v}: v' = -u`);
	}
	assert.ok(checked >= 8, `${checked} vertices on long-axis faces`);
});

test('barUvs: the turn is a rotation, so every triangle keeps its winding sign (not mirrored; normal maps need this)', () => {
	const cases: [[number, number, number], [number, number, number]][] = [
		[[0, 0, 0], [0.1, 2.4, 0.1]],
		[[0, 0, 0], [2.2, 0.08, 0.08]],
		[[0, 0, 0], [0.09, 0.09, 1.5]],
	];
	for (const [min, max] of cases) {
		const g = bar(min, max);
		const plain = boxUvs(g.pos, g.nor, 1);
		const turned = barUvs(g.pos, g.nor, 1, longAxisOf(min, max));
		for (let t = 0; t < g.index.length; t += 3) {
			const sign = (uv: number[]) => {
				const [a, b, c] = [g.index[t], g.index[t + 1], g.index[t + 2]];
				const det = (uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1]);
				return Math.sign(Math.abs(det) < 1e-9 ? 0 : det);
			};
			assert.equal(sign(turned), sign(plain), `triangle ${t / 3} in bar ${max}`);
		}
	}
});

test('barUvs: the grain runs along the bar: an edge along the long axis changes only u on every face that has one', () => {
	const cases: [[number, number, number], [number, number, number], Axis][] = [
		[[0, 0, 0], [0.1, 2.4, 0.1], 1], // vertical muntin
		[[0, 0, 0], [2.2, 0.08, 0.08], 0], // horizontal sill
		[[0, 0, 0], [0.09, 0.09, 1.5], 2], // bar in depth
	];
	for (const [min, max, longAxis] of cases) {
		const g = bar(min, max);
		const uv = barUvs(g.pos, g.nor, 1, longAxis);
		let edges = 0;
		for (let a = 0; a < g.pos.length / 3; a++) for (let b = a + 1; b < g.pos.length / 3; b++) {
			const pa = [g.pos[a * 3], g.pos[a * 3 + 1], g.pos[a * 3 + 2]];
			const pb = [g.pos[b * 3], g.pos[b * 3 + 1], g.pos[b * 3 + 2]];
			const na = [g.nor[a * 3], g.nor[a * 3 + 1], g.nor[a * 3 + 2]];
			const nb = [g.nor[b * 3], g.nor[b * 3 + 1], g.nor[b * 3 + 2]];
			if (na.some((v, i) => Math.abs(v - nb[i]) > EPS)) continue; // same face only
			const others = [0, 1, 2].filter((i) => i !== longAxis);
			if (!others.every((i) => Math.abs(pa[i] - pb[i]) < EPS)) continue; // not an edge along the long axis
			const along = Math.abs(pa[longAxis] - pb[longAxis]);
			if (along < EPS) continue;
			edges++;
			const du = Math.abs(uv[a * 2] - uv[b * 2]);
			const dv = Math.abs(uv[a * 2 + 1] - uv[b * 2 + 1]);
			assert.ok(Math.abs(du - along) < EPS, `u moves with the bar (${du} vs ${along})`);
			assert.ok(dv < EPS, `v stays put along the bar (${dv}): the grain is not across it`);
		}
		assert.ok(edges >= 4, `bar along ${longAxis}: ${edges} edges checked`);
	}
});

test('barUvs: the faces with the long axis as their normal (the two ends) are unchanged', () => {
	const g = bar([0, 0, 0], [0.1, 2.4, 0.1]);
	const plain = boxUvs(g.pos, g.nor, 1);
	const turned = barUvs(g.pos, g.nor, 1, 1);
	let ends = 0;
	for (let v = 0; v < g.pos.length / 3; v++) {
		const n = [g.nor[v * 3], g.nor[v * 3 + 1], g.nor[v * 3 + 2]];
		if (faceNormalAxisOf(n) !== 1) continue;
		ends++;
		assert.equal(turned[v * 2], plain[v * 2]);
		assert.equal(turned[v * 2 + 1], plain[v * 2 + 1]);
	}
	assert.ok(ends >= 4, `${ends} end-cap vertices`);
});

test('barUvs: world space, so a thin bar is not squeezed: on the long faces u = y / tile exactly, at 1 m per tile unit', () => {
	const g = bar([0, 0, 0], [0.09, 2.4, 0.09]);
	const tile = 0.8;
	const uv = barUvs(g.pos, g.nor, tile, 1);
	let long = 0;
	for (let v = 0; v < g.pos.length / 3; v++) {
		const n = [g.nor[v * 3], g.nor[v * 3 + 1], g.nor[v * 3 + 2]];
		if (vAxisOf(n) !== 1) continue;
		long++;
		assert.ok(Math.abs(uv[v * 2] - g.pos[v * 3 + 1] / tile) < EPS, `vertex ${v}: u ${uv[v * 2]} vs y/tile ${g.pos[v * 3 + 1] / tile}`);
	}
	assert.ok(long >= 8, `${long} long-face vertices`);
	// the bar's 2.4 m length is 2.4 / tile uv units along the grain, the same density as a wall at the same tile
	const us = [...Array(g.pos.length / 3)].map((_, v) => uv[v * 2]);
	const span = Math.max(...us) - Math.min(...us);
	assert.ok(Math.abs(span - 2.4 / tile) < 1e-3, `u span ${span} vs ${2.4 / tile}`);
});

test('barUvs: a bad tile throws (it is boxUvs underneath)', () => {
	const g = bar([0, 0, 0], [0.1, 2.4, 0.1]);
	assert.throws(() => barUvs(g.pos, g.nor, 0, 1), RangeError);
	assert.throws(() => barUvs(g.pos, g.nor, -1, 1), RangeError);
});
