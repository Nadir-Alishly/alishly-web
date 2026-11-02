// Unit tests for src/data/window-wood.ts (the window wood's texture transform, bar grain axis and tint fallback).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowMapTransform, longAxisOf, WINDOW_UV_TILE, DARK_WOOD_LINEAR } from '../src/data/window-wood.ts';
import { DEFAULT_SETTINGS, SETTING_RANGES } from '../src/data/scene-settings.ts';

test('windowMapTransform: the tile is world units per repeat, so repeat = WINDOW_UV_TILE / tile', () => {
	const base = { tile: 0.8, rotation: 0, offsetX: 0, offsetY: 0 };
	assert.equal(WINDOW_UV_TILE, 1, 'the bar uvs are world-space at 1 m per uv unit');
	assert.deepEqual(windowMapTransform(base), { repeat: 1.25, rotation: 0, offsetX: 0, offsetY: 0 });
	assert.equal(windowMapTransform({ ...base, tile: 2 }).repeat, 0.5, 'a bigger tile gives a bigger grain (fewer repeats)');
	assert.equal(windowMapTransform({ ...base, tile: 4 }).repeat, 0.25);
	assert.equal(windowMapTransform({ ...base, tile: 0.1 }).repeat, 10);
});

test('windowMapTransform: rotation and offsets pass through unchanged', () => {
	const t = windowMapTransform({ tile: 1, rotation: -90, offsetX: 0.25, offsetY: -0.5 });
	assert.deepEqual(t, { repeat: 1, rotation: -90, offsetX: 0.25, offsetY: -0.5 });
});

test('windowMapTransform: the default settings give the planned texture scale (repeat 1.25 on each axis)', () => {
	assert.deepEqual(windowMapTransform(DEFAULT_SETTINGS.window), { repeat: 1.25, rotation: 0, offsetX: 0, offsetY: 0 });
});

test('windowMapTransform: every value in the admin ranges gives a finite, positive repeat (no divide-by-zero, no NaN)', () => {
	const r = SETTING_RANGES.window;
	for (const tile of [r.tile.min, r.tile.max, (r.tile.min + r.tile.max) / 2]) {
		const t = windowMapTransform({ tile, rotation: r.rotation.min, offsetX: r.offsetX.min, offsetY: r.offsetY.max });
		assert.ok(Number.isFinite(t.repeat) && t.repeat > 0, `tile ${tile} -> repeat ${t.repeat}`);
	}
});

test('longAxisOf: the longest box side (0 x, 1 y, 2 z)', () => {
	assert.equal(longAxisOf([0, 0, 0], [0.1, 2.4, 0.1]), 1, 'a tall muntin runs along y');
	assert.equal(longAxisOf([0, 0, 0], [2.2, 0.08, 0.08]), 0, 'a horizontal bar runs along x');
	assert.equal(longAxisOf([0, 0, 0], [0.09, 0.09, 1.5]), 2, 'a bar in depth runs along z');
});

test('longAxisOf: ties go to the earlier axis (a square section has no long side; x first)', () => {
	assert.equal(longAxisOf([0, 0, 0], [1, 1, 1]), 0);
	assert.equal(longAxisOf([0, 0, 0], [0.5, 0.5, 0.2]), 0, 'x = y is a tie, so x');
	assert.equal(longAxisOf([0, 0, 0], [0.2, 0.5, 0.5]), 1, 'y = z is a tie, so y');
});

test('longAxisOf: works with an offset box (only the size matters)', () => {
	assert.equal(longAxisOf([-3, 1, 2], [-2.9, 3.5, 2.1]), 1);
	assert.equal(longAxisOf([10, -5, 0], [12, -4.9, 0.1]), 0);
});

test('DARK_WOOD_LINEAR: the fallback colour is a dark warm brown in linear light (each channel in (0,1), red > green > blue)', () => {
	for (const c of DARK_WOOD_LINEAR) assert.ok(c > 0 && c < 1, `${c}`);
	const [r, g, b] = DARK_WOOD_LINEAR;
	assert.ok(r > g && g > b, 'warm: red > green > blue');
	assert.ok(r + g + b < 0.5, 'dark');
});
