// Unit tests for src/data/room-glow.ts (window halo rect and the sun's light patch on the floor). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haloRect, sunPatch, polygonBounds, HALO_SPREAD, POOL_SPREAD } from '../src/data/room-glow.ts';
import { WINDOW_OPENING } from '../src/data/room-window.ts';
import { SUN_POSITION } from '../src/data/room-sun.ts';
import { ROOM_DIMS } from '../src/data/scene.ts';

const D = ROOM_DIMS;
const O = WINDOW_OPENING;
const EPS = 1e-9;

test('haloRect: contains the opening, is larger than it, and stays on the wall', () => {
	const { rect } = haloRect(D, O);
	assert.ok(rect.z0 <= O.z0 && rect.z1 >= O.z1 && rect.y0 <= O.y0 && rect.y1 >= O.y1, 'contains the opening');
	assert.ok(rect.z1 - rect.z0 > O.z1 - O.z0 && rect.y1 - rect.y0 > O.y1 - O.y0, 'bigger than the opening');
	assert.ok(rect.z0 >= -D.inner - EPS && rect.z1 <= D.half + EPS, 'within the wall in z');
	assert.ok(rect.y0 >= 0 && rect.y1 <= D.wallHeight + EPS, 'between floor and wall top');
});

test('haloRect: reaches HALO_SPREAD beyond the opening where the wall allows, and is clamped where it does not', () => {
	const { rect } = haloRect(D, O);
	const expect = {
		z0: Math.max(-D.inner, O.z0 - HALO_SPREAD),
		z1: Math.min(D.half, O.z1 + HALO_SPREAD),
		y0: Math.max(0, O.y0 - HALO_SPREAD),
		y1: Math.min(D.wallHeight, O.y1 + HALO_SPREAD),
	};
	assert.deepEqual(rect, expect);
	// With the current numbers the wall top clips the halo (2.35 + 0.95 > 3), so y1 is exactly the wall top.
	assert.equal(rect.y1, D.wallHeight);
});

test('haloRect: the hole fractions are inside 0..1 and map back exactly onto the opening', () => {
	for (const spread of [0.1, HALO_SPREAD, 3, 50]) {
		const { rect, hole } = haloRect(D, O, spread);
		for (const v of Object.values(hole)) assert.ok(v >= -EPS && v <= 1 + EPS, `spread ${spread}: ${v}`);
		assert.ok(hole.z0 < hole.z1 && hole.y0 < hole.y1);
		const w = rect.z1 - rect.z0;
		const h = rect.y1 - rect.y0;
		assert.ok(Math.abs(rect.z0 + hole.z0 * w - O.z0) < 1e-9);
		assert.ok(Math.abs(rect.z0 + hole.z1 * w - O.z1) < 1e-9);
		assert.ok(Math.abs(rect.y0 + hole.y0 * h - O.y0) < 1e-9);
		assert.ok(Math.abs(rect.y0 + hole.y1 * h - O.y1) < 1e-9);
	}
});

test('haloRect: a bigger spread never shrinks the rect; a huge spread is exactly the visible wall', () => {
	const a = haloRect(D, O, 0.2).rect;
	const b = haloRect(D, O, 0.8).rect;
	assert.ok(b.z0 <= a.z0 && b.z1 >= a.z1 && b.y0 <= a.y0 && b.y1 >= a.y1);
	assert.deepEqual(haloRect(D, O, 100).rect, { z0: -D.inner, z1: D.half, y0: 0, y1: D.wallHeight });
	assert.deepEqual(haloRect(D, O, 0).rect, { z0: O.z0, z1: O.z1, y0: O.y0, y1: O.y1 });
});

test('sunPatch: four corners on the room side of the wall, offset along the sun ray, with the opening shape', () => {
	const p = sunPatch(D, O, SUN_POSITION);
	assert.equal(p.length, 4);
	for (const [x] of p) assert.ok(x > -D.inner, `corner x ${x} is inside the room`);
	const [sx, sy, sz] = SUN_POSITION;
	// Each corner is the opening corner moved down to the floor along the ray: x grows by sx*y/sy (sx < 0 → +).
	const ys = [O.y0, O.y0, O.y1, O.y1];
	const zs = [O.z0, O.z1, O.z1, O.z0];
	for (const [i, [x, z]] of p.entries()) {
		assert.ok(Math.abs(x - (-D.inner - (sx * ys[i]) / sy)) < EPS);
		assert.ok(Math.abs(z - (zs[i] - (sz * ys[i]) / sy)) < EPS);
	}
	// Higher edge of the opening lands farther into the room, and the patch is a parallelogram (same z width).
	assert.ok(p[2][0] > p[0][0]);
	assert.ok(Math.abs(p[1][1] - p[0][1] - (O.z1 - O.z0)) < EPS);
});

test('sunPatch: a sun straight above drops the corners under the opening; invalid suns throw', () => {
	const p = sunPatch(D, O, [0, 5, 0]);
	for (const [i, [x, z]] of p.entries()) {
		assert.ok(Math.abs(x + D.inner) < EPS);
		assert.ok(Math.abs(z - [O.z0, O.z1, O.z1, O.z0][i]) < EPS);
	}
	assert.throws(() => sunPatch(D, O, [-9, 0, 0]), RangeError);
	assert.throws(() => sunPatch(D, O, [-9, -1, 0]), RangeError);
});

test('sunPatch: the current patch sits on the floor (within the room bounds, nothing absurdly far)', () => {
	const b = polygonBounds(sunPatch(D, O, SUN_POSITION));
	assert.ok(b.x0 > -D.inner && b.x1 < D.half, `x ${b.x0}..${b.x1} within the room`);
	assert.ok(b.z1 - b.z0 > O.z1 - O.z0 - EPS, 'patch is at least as wide as the opening');
	// The pool (patch + POOL_SPREAD) spreads past the patch but must still reach no further than the floor slab.
	const pool = polygonBounds(sunPatch(D, O, SUN_POSITION), POOL_SPREAD);
	assert.ok(pool.x0 > -D.half - 2 && pool.x1 < D.half + 2, 'pool is near the floor');
});

test('polygonBounds: bounds with and without margin', () => {
	const pts: [number, number][] = [[1, 2], [-3, 5], [4, -1]];
	assert.deepEqual(polygonBounds(pts), { x0: -3, x1: 4, z0: -1, z1: 5 });
	assert.deepEqual(polygonBounds(pts, 0.5), { x0: -3.5, x1: 4.5, z0: -1.5, z1: 5.5 });
});
