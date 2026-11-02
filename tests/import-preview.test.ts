// Unit tests for src/data/import-preview.ts (the admin's live import ghost: its default scale, object scale after the size
// limits, the floor spot "Add to room" would use, and its opacity). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	previewDefaultScale, previewObjectScale, pickSpot, ghostOpacity, GHOST_OPACITY,
} from '../src/data/import-preview.ts';
import { clampObjectScale, withinSizeLimits, worldSize, SIZE_LIMITS } from '../src/data/object-size.ts';
import { LIMITS } from '../src/data/scene.ts';
import type { Vec3 } from '../src/data/scene.ts';

// ---------- the form's default scale, as typed ----------

test('previewDefaultScale: blank, non-numeric, zero and negative text means "no change" (null)', () => {
	for (const t of ['', '   ', 'abc', '1e', '0', '-2', 'NaN', 'Infinity']) {
		assert.equal(previewDefaultScale(t), null, JSON.stringify(t));
	}
});

test('previewDefaultScale: a number is rounded to 4 significant digits, as Add would store it', () => {
	assert.equal(previewDefaultScale('2'), 2);
	assert.equal(previewDefaultScale('  3  '), 3, 'surrounding spaces are fine');
	assert.equal(previewDefaultScale('1.23456'), 1.235);
	assert.equal(previewDefaultScale('0.012346'), 0.01235);
});

test('previewDefaultScale: clamped to the LIMITS multiplier range', () => {
	assert.equal(previewDefaultScale('0.0000001'), LIMITS.minScale, 'below the minimum');
	assert.equal(previewDefaultScale('999'), LIMITS.maxScale, 'above the maximum');
	assert.equal(LIMITS.minScale, 0.001);
	assert.equal(LIMITS.maxScale, 50);
});

// ---------- the object scale a placed copy gets ----------

test('previewObjectScale: no known size -> [1, 1, 1], not clamped (nothing to measure)', () => {
	assert.deepEqual(previewObjectScale(null, 3), { scale: [1, 1, 1], clamped: false });
});

test('previewObjectScale: a model that fits stays at scale 1 with no clamp', () => {
	const r = previewObjectScale([1, 1, 1], 1);
	assert.deepEqual(r.scale, [1, 1, 1]);
	assert.equal(r.clamped, false);
});

test('previewObjectScale: the same clamp a placed object gets (clampObjectScale on native × defaultScale)', () => {
	const cases: [Vec3, number][] = [
		[[20, 20, 20], 1], // far too big
		[[0.001, 0.001, 0.001], 1], // far too small
		[[0.785, 0.993, 0.967], 2], // piano-like
		[[2, 0.035, 1.4], 1], // a thin rug
	];
	for (const [native, d] of cases) {
		const expected = clampObjectScale(native.map((n) => n * d) as Vec3, [1, 1, 1]);
		const got = previewObjectScale(native, d);
		assert.deepEqual(got.scale, expected.scale, JSON.stringify([native, d]));
		assert.equal(got.clamped, expected.clamped, JSON.stringify([native, d]));
	}
});

test('previewObjectScale: an oversized model is shrunk to the largest-side limit (8 m), and the result is inside the limits', () => {
	const native: Vec3 = [20, 20, 20];
	const r = previewObjectScale(native, 1);
	assert.equal(r.clamped, true);
	assert.ok(withinSizeLimits(native, r.scale), 'within the size limits');
	const size = worldSize(native, r.scale);
	assert.ok(Math.max(...size) <= SIZE_LIMITS.maxLargest + 1e-6, `largest side ${Math.max(...size)} m`);
	assert.ok(Math.abs(Math.max(...size) - SIZE_LIMITS.maxLargest) < 1e-6, 'it stops at exactly the limit');
});

test('previewObjectScale: the scale is always inside the LIMITS multiplier range', () => {
	for (const native of [[0.001, 0.001, 0.001], [1, 1, 1], [40, 1, 1], [0.5, 0.5, 0.5]] as Vec3[]) {
		for (const d of [0.001, 1, 50]) {
			for (const s of previewObjectScale(native, d).scale) {
				assert.ok(s >= LIMITS.minScale - 1e-9 && s <= LIMITS.maxScale + 1e-9, `${s} for ${native} x${d}`);
			}
		}
	}
});

// ---------- where "Add to room" would put it ----------

const SPOTS: [number, number][] = [[0, 0], [1, 0], [0, 1]];

test('pickSpot: the first spot with nothing within 0.6 m of it; an empty room takes the first spot', () => {
	assert.deepEqual(pickSpot(SPOTS, []), [0, 0]);
});

test('pickSpot: a spot with an object within 0.6 m is taken; the next free one is used', () => {
	assert.deepEqual(pickSpot(SPOTS, [[0.3, 0.5, 0]]), [1, 0], 'first spot taken, second free');
	assert.deepEqual(pickSpot(SPOTS, [[0.3, 0.5, 0], [1.2, 0, 0.1]]), [0, 1], 'first and second taken');
});

test('pickSpot: the 0.6 m distance is strict (exactly 0.6 away still counts as taken; a hair further is free)', () => {
	// exactly 0.6 m from spot 0 blocks it; spot 1 at (1, 0) is only 0.4 m away, so spot 2 at (0, 1) is the one free
	assert.deepEqual(pickSpot(SPOTS, [[0.6, 0, 0]]), [0, 1]);
	// 0.61 m from spot 0 leaves spot 0 free
	assert.deepEqual(pickSpot(SPOTS, [[0.61, 0, 0]]), [0, 0]);
});

test('pickSpot: when every spot is taken, the first spot is used (the object still lands somewhere)', () => {
	assert.deepEqual(pickSpot(SPOTS, [[0, 0, 0], [1, 0, 0], [0, 0, 1]]), [0, 0]);
});

test('pickSpot: only the x and z plane counts (height does not make a spot free)', () => {
	assert.deepEqual(pickSpot(SPOTS, [[0, 5, 0]]), [1, 0], 'an object high above spot 0 still blocks it: spot 1 is used');
});

// ---------- opacity ----------

test('ghostOpacity: scales each material by GHOST_OPACITY (0.45), never above its own opacity', () => {
	assert.equal(GHOST_OPACITY, 0.45);
	assert.equal(ghostOpacity(1), 0.45);
	assert.equal(ghostOpacity(0.5), 0.225);
	assert.equal(ghostOpacity(0), 0);
	assert.equal(ghostOpacity(2), 0.45, 'an over-1 opacity is treated as 1');
});

test('ghostOpacity: the values are rounded to 4 decimals', () => {
	const v = ghostOpacity(0.333333);
	assert.equal(v, Math.round(0.333333 * 0.45 * 1e4) / 1e4);
});
