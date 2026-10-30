// Unit tests for src/data/room-floor.ts (seeded PRNG and the plank layout of the floor texture). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, plankLayout, FLOOR_PLANKS, type FloorPlankSpec, type Plank } from '../src/data/room-floor.ts';

const EPS = 1e-9;
const byRow = (planks: Plank[], rows: number) =>
	Array.from({ length: rows }, (_, r) => planks.filter((p) => p.row === r).sort((a, b) => a.u0 - b.u0));

test('mulberry32: same seed gives the same sequence, different seeds differ, values are in [0, 1)', () => {
	const a = mulberry32(42);
	const b = mulberry32(42);
	const seqA = Array.from({ length: 50 }, a);
	const seqB = Array.from({ length: 50 }, b);
	assert.deepEqual(seqA, seqB);
	assert.notDeepEqual(seqA, Array.from({ length: 50 }, mulberry32(43)));
	for (const v of seqA) assert.ok(v >= 0 && v < 1);
	assert.ok(new Set(seqA).size > 45, 'not stuck');
});

test('plankLayout: deterministic (default spec and a custom seed), different seeds differ', () => {
	assert.deepEqual(plankLayout(), plankLayout());
	assert.deepEqual(plankLayout(), plankLayout(FLOOR_PLANKS));
	const other: FloorPlankSpec = { ...FLOOR_PLANKS, seed: FLOOR_PLANKS.seed + 1 };
	assert.deepEqual(plankLayout(other), plankLayout(other));
	assert.notDeepEqual(plankLayout(other).planks, plankLayout().planks);
});

test('plankLayout: row count is size / width; every plank belongs to a row', () => {
	const { rows, planks } = plankLayout();
	assert.equal(rows, Math.round(FLOOR_PLANKS.size / FLOOR_PLANKS.width));
	assert.equal(rows, 16);
	for (const p of planks) assert.ok(Number.isInteger(p.row) && p.row >= 0 && p.row < rows);
	for (const r of byRow(planks, rows)) assert.ok(r.length >= 1, 'no empty row');
});

test('plankLayout: planks are in bounds, ordered, with no gaps or overlaps; each row covers 0..1 exactly', () => {
	const { rows, planks } = plankLayout();
	for (const p of planks) {
		assert.ok(p.u0 >= 0 && p.u1 <= 1 + EPS, `plank in 0..1: ${p.u0}..${p.u1}`);
		assert.ok(p.u1 > p.u0, 'positive length');
		assert.ok(p.tone >= -1 && p.tone <= 1, `tone ${p.tone}`);
	}
	for (const [r, row] of byRow(planks, rows).entries()) {
		assert.ok(Math.abs(row[0].u0) < EPS, `row ${r} starts at 0`);
		assert.ok(Math.abs(row[row.length - 1].u1 - 1) < EPS, `row ${r} ends at 1`);
		for (let i = 1; i < row.length; i++) {
			assert.ok(Math.abs(row[i].u0 - row[i - 1].u1) < EPS, `row ${r} plank ${i}: no gap/overlap`);
		}
		const total = row.reduce((s, p) => s + (p.u1 - p.u0), 0);
		assert.ok(Math.abs(total - 1) < 1e-9, `row ${r} total ${total}`);
	}
});

test('plankLayout: plank lengths are within the spec (the first plank of a row may be shorter)', () => {
	const { rows, planks } = plankLayout();
	const { size, minLength, maxLength } = FLOOR_PLANKS;
	for (const row of byRow(planks, rows)) {
		for (const [i, p] of row.entries()) {
			const len = (p.u1 - p.u0) * size;
			assert.ok(len <= maxLength * 1.5 + 1e-6, `plank too long: ${len}`);
			if (i > 0 && i < row.length - 1) assert.ok(len >= minLength - 1e-6, `interior plank too short: ${len}`);
			assert.ok(len >= minLength * 0.25, `no slivers: ${len}`);
		}
	}
});

test('plankLayout: end joints of neighbouring rows are staggered', () => {
	const { rows, planks } = plankLayout();
	const rowsOf = byRow(planks, rows);
	const joints = rowsOf.map((r) => r.slice(1).map((p) => p.u0));
	let worst = Infinity;
	for (let r = 1; r < rows; r++) {
		for (const a of joints[r]) for (const b of joints[r - 1]) worst = Math.min(worst, Math.abs(a - b));
	}
	// The generator retries but may settle for the best of 24; require a visible stagger (not joints lined up).
	assert.ok(worst * FLOOR_PLANKS.size > 0.1, `closest neighbouring joints ${worst * FLOOR_PLANKS.size} units apart`);
	// And the row-to-row pattern is not one repeated row.
	assert.ok(new Set(joints.map((j) => j.map((u) => u.toFixed(3)).join(','))).size > rows / 2);
});

test('plankLayout: tones vary between planks (a plain floor would be flat)', () => {
	const tones = plankLayout().planks.map((p) => p.tone);
	assert.ok(Math.max(...tones) - Math.min(...tones) > 1);
});

test('plankLayout: works for other sizes and does not hang on a short floor', () => {
	const spec: FloorPlankSpec = { size: 2, width: 0.5, minLength: 0.8, maxLength: 1.2, minStagger: 0.1, seed: 7 };
	const { rows, planks } = plankLayout(spec);
	assert.equal(rows, 4);
	for (const row of byRow(planks, rows)) {
		assert.ok(Math.abs(row[0].u0) < EPS && Math.abs(row[row.length - 1].u1 - 1) < EPS);
	}
	// A plank longer than the floor: each row is a single plank.
	const one = plankLayout({ ...spec, minLength: 5, maxLength: 6 });
	for (const row of byRow(one.planks, one.rows)) assert.equal(row.length, 1);
});
