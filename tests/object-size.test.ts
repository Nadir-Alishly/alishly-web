// Unit tests for src/data/object-size.ts (world-size limits for objects in the admin editor). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIZE_LIMITS, SIZE_LIMIT_HINT, clampObjectScale, worldSize, withinSizeLimits } from '../src/data/object-size.ts';
import { LIMITS, roundTo } from '../src/data/scene.ts';
import type { Vec3 } from '../src/data/scene.ts';

const TOL = 1e-6;
const PIANO: Vec3 = [0.785, 0.993, 0.967]; // piano-like native size (x defaultScale)
const RUG: Vec3 = [2, 0.035, 1.4];
const CRATE: Vec3 = [1, 1, 1];

const near = (a: number, b: number, tol = TOL) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
const nearVec = (a: Vec3, b: Vec3, tol = TOL) => a.forEach((v, i) => near(v, b[i], tol));
const largest = (native: Vec3, scale: Vec3) => Math.max(...worldSize(native, scale));
// What the editor does after the clamp (readBack / roundTo): must be a no-op for the limits.
const rounded = (s: Vec3): Vec3 => [roundTo(s[0]), roundTo(s[1]), roundTo(s[2])];
const inScaleRange = (s: Vec3) => s.every((v) => v >= LIMITS.minScale && v <= LIMITS.maxScale);

test('SIZE_LIMITS is pinned and the hint text matches', () => {
	assert.deepEqual({ ...SIZE_LIMITS }, { minLargest: 0.25, maxLargest: 8, minAxis: 0.01 });
	assert.equal(SIZE_LIMIT_HINT, 'Size limit: 25 cm – 8 m');
});

test('worldSize multiplies per axis; withinSizeLimits honours the boundaries and the tolerance', () => {
	assert.deepEqual(worldSize([2, 3, 4], [1, 0.5, 0.25]), [2, 1.5, 1]);
	assert.equal(withinSizeLimits(CRATE, [0.25, 0.25, 0.25]), true);
	assert.equal(withinSizeLimits(CRATE, [8, 8, 8]), true);
	assert.equal(withinSizeLimits(CRATE, [1, 0.01, 1]), true);
	assert.equal(withinSizeLimits(CRATE, [0.249, 0.249, 0.249]), false, 'largest side below 25 cm');
	assert.equal(withinSizeLimits(CRATE, [0.1, 0.1, 0.1]), false, '10 cm is no longer enough');
	assert.equal(withinSizeLimits(CRATE, [8.001, 1, 1]), false, 'above 8 m');
	assert.equal(withinSizeLimits(CRATE, [1, 0.0099, 1]), false, 'axis below 1 cm');
	assert.equal(withinSizeLimits(CRATE, [8 + 1e-7, 1, 1]), true, 'inside the 1e-6 tolerance');
});

// ---------- exact boundaries: no clamp, input returned untouched ----------

test('exactly at the limits: not clamped, input returned unchanged', () => {
	for (const scale of [[0.25, 0.25, 0.25], [8, 8, 8], [8, 0.01, 0.01], [0.25, 0.01, 0.01], [1, 0.01, 1]] as Vec3[]) {
		const r = clampObjectScale(CRATE, scale, [1, 1, 1]);
		assert.equal(r.clamped, false, `scale ${scale}`);
		assert.deepEqual(r.scale, scale);
	}
});

test('a normal in-range scale is returned as is (same values, a copy), clamped false', () => {
	const input: Vec3 = [1.23456789, 0.5, 2];
	const r = clampObjectScale(PIANO, input, [1, 1, 1]);
	assert.equal(r.clamped, false);
	assert.deepEqual(r.scale, input);
	assert.notEqual(r.scale, input, 'a copy, not the same array');
});

// ---------- upper cap ----------

test('just above 8 m on one axis is capped to 8 m, other axes untouched', () => {
	const r = clampObjectScale(CRATE, [8.001, 1, 1], [1, 1, 1]);
	assert.equal(r.clamped, true);
	nearVec(worldSize(CRATE, r.scale), [8, 1, 1]);
	assert.ok(r.scale[0] <= 8 && r.scale[0] >= 7.9999);
});

test('every axis is capped at 8 m, not only the largest', () => {
	const r = clampObjectScale(PIANO, [1000, 1000, 1000], [1, 1, 1]);
	assert.equal(r.clamped, true);
	for (let i = 0; i < 3; i++) assert.ok(worldSize(PIANO, r.scale)[i] <= 8 + TOL, `axis ${i}`);
	near(worldSize(PIANO, r.scale)[0], 8, 1e-3);
	assert.ok(withinSizeLimits(PIANO, rounded(r.scale)));
	assert.ok(inScaleRange(r.scale));
});

test('uniform 1000 on a 1 m cube: all axes end at 8 m', () => {
	const r = clampObjectScale(CRATE, [1000, 1000, 1000], [1, 1, 1]);
	assert.equal(r.clamped, true);
	assert.deepEqual(r.scale, [8, 8, 8]);
});

test('a big native size caps the multiplier below 8 (5 m tall plant x 2 -> 8/4.9)', () => {
	const plant: Vec3 = [1.2, 4.9, 1.2];
	const r = clampObjectScale(plant, [2, 2, 2], [1, 1, 1]);
	assert.equal(r.clamped, true);
	near(worldSize(plant, r.scale)[1], 8, 1e-3);
	assert.ok(r.scale[1] <= 8 / 4.9);
	assert.deepEqual([r.scale[0], r.scale[2]], [2, 2], 'other axes untouched (1.2 * 2 = 2.4 m is fine)');
});

test('an existing 4.9 m object at x1 is within limits and not clamped', () => {
	const r = clampObjectScale([1.2, 4.9, 1.2], [1, 1, 1], [1, 1, 1]);
	assert.equal(r.clamped, false);
	assert.deepEqual(r.scale, [1, 1, 1]);
});

// ---------- lower limit (largest side) ----------

test('uniform shrink: largest side lands at exactly 25 cm and proportions are kept', () => {
	// 0.05 on a piano-like model: every axis is still above 1 cm, so only the 25 cm rule applies
	const r = clampObjectScale(PIANO, [0.05, 0.05, 0.05], [1, 1, 1]);
	assert.equal(r.clamped, true);
	const w = worldSize(PIANO, r.scale);
	near(Math.max(...w), 0.25, 1e-3);
	assert.ok(Math.max(...w) >= 0.25 - TOL, 'never below the floor after rounding');
	near(r.scale[0], r.scale[1], 1e-3);
	near(r.scale[1], r.scale[2], 1e-3);
	assert.ok(withinSizeLimits(PIANO, rounded(r.scale)));
	assert.ok(inScaleRange(r.scale));
});

// Regression test for tester-r1 bug 1: an extreme uniform shrink used to floor every axis to 1 cm first and turned a
// 0.8x1.0x1.0 m model into a cube. The floor now runs after the common factor.
test('uniform extreme shrink (0.00001) keeps the proportions of the model (bug 1 fixed)', () => {
	const r = clampObjectScale(PIANO, [0.00001, 0.00001, 0.00001], [1, 1, 1]);
	assert.equal(r.clamped, true);
	const w = worldSize(PIANO, r.scale);
	near(Math.max(...w), 0.25, 1e-3);
	near(w[0] / w[1], PIANO[0] / PIANO[1], 1e-2);
	near(w[2] / w[1], PIANO[2] / PIANO[1], 1e-2);
});

test('uniform extreme shrink (0.00001) still ends inside every limit with largest side 25 cm', () => {
	const r = clampObjectScale(PIANO, [0.00001, 0.00001, 0.00001], [1, 1, 1]);
	assert.equal(r.clamped, true);
	near(Math.max(...worldSize(PIANO, r.scale)), 0.25, 1e-3);
	assert.ok(withinSizeLimits(PIANO, rounded(r.scale)));
	assert.ok(inScaleRange(r.scale));
});

test('uniform shrink on a 1 m cube gives exactly 0.25', () => {
	const r = clampObjectScale(CRATE, [0.00001, 0.00001, 0.00001], [1, 1, 1]);
	assert.equal(r.clamped, true);
	assert.deepEqual(r.scale, [0.25, 0.25, 0.25]);
});

test('just below 25 cm (0.2499) is lifted to 25 cm; exactly 0.25 is not touched; 0.1 is lifted now', () => {
	const below = clampObjectScale(CRATE, [0.2499, 0.2499, 0.2499], [1, 1, 1]);
	assert.equal(below.clamped, true);
	assert.deepEqual(below.scale, [0.25, 0.25, 0.25]);
	assert.equal(clampObjectScale(CRATE, [0.25, 0.25, 0.25], [1, 1, 1]).clamped, false);
	assert.deepEqual(clampObjectScale(CRATE, [0.1, 0.1, 0.1], [1, 1, 1]).scale, [0.25, 0.25, 0.25]);
});

test('shrinking without prevScale scales all axes together', () => {
	const r = clampObjectScale(CRATE, [0.01, 0.02, 0.03]);
	assert.equal(r.clamped, true);
	nearVec(worldSize(CRATE, r.scale), [0.0833333, 0.1666667, 0.25], 1e-3);
});

test('single-axis shrink: only the changed axis is touched, the others are not inflated', () => {
	// piano with x,z at 0.5; user types y tiny -> y floors at 1 cm, the others stay
	const prev: Vec3 = [1, 1, 1];
	const r = clampObjectScale(PIANO, [1, 0.0001, 1], prev);
	assert.equal(r.clamped, true);
	assert.equal(r.scale[0], 1);
	assert.equal(r.scale[2], 1);
	near(worldSize(PIANO, r.scale)[1], 0.01, 1e-3);
	assert.ok(worldSize(PIANO, r.scale)[1] >= 0.01 - TOL);
});

test('single-axis edit that makes the largest side too small raises only the changed axis', () => {
	// all other axes are already small (largest side comes from the edited axis)
	const prev: Vec3 = [0.05, 0.05, 0.05];
	const r = clampObjectScale(CRATE, [0.05, 0.05, 0.02], prev);
	// x,y are already 0.05 (largest 5 cm < 25 cm): only z changed so only z is lifted (to 0.25)
	assert.equal(r.clamped, true);
	assert.equal(r.scale[0], 0.05);
	assert.equal(r.scale[1], 0.05);
	near(r.scale[2], 0.25);
});

test('gizmo-like uniform step with prevScale keeps proportions of the changed axes', () => {
	const prev: Vec3 = [0.2, 0.1, 0.05];
	const r = clampObjectScale(CRATE, [0.04, 0.02, 0.01], prev);
	assert.equal(r.clamped, true);
	nearVec(r.scale, [0.25, 0.125, 0.0625], 1e-4);
});

test('when prevScale equals the new scale (nothing changed), all axes are lifted', () => {
	const s: Vec3 = [0.01, 0.02, 0.03];
	const r = clampObjectScale(CRATE, s, s);
	assert.equal(r.clamped, true);
	near(Math.max(...worldSize(CRATE, r.scale)), 0.25, 1e-3);
});

// ---------- per-axis 1 cm floor / rug ----------

test('per-axis floor: an axis under 1 cm is raised to exactly 1 cm world size', () => {
	const r = clampObjectScale(CRATE, [1, 0.009, 1], [1, 1, 1]);
	assert.equal(r.clamped, true);
	assert.deepEqual(r.scale, [1, 0.01, 1]);
});

test('rug-like thin native size at x1: thin axis (3.5 cm) is kept and nothing is clamped', () => {
	const r = clampObjectScale(RUG, [1, 1, 1], [1, 1, 1]);
	assert.equal(r.clamped, false);
	assert.deepEqual(r.scale, [1, 1, 1]);
	near(worldSize(RUG, r.scale)[1], 0.035);
});

test('rug: scaling x/z leaves the thin axis at 3.5 cm (not forced up)', () => {
	const r = clampObjectScale(RUG, [3, 1, 3], [1, 1, 1]);
	assert.equal(r.clamped, false);
	assert.deepEqual(r.scale, [3, 1, 3]);
	const w = worldSize(RUG, r.scale);
	near(w[1], 0.035);
	near(w[0], 6);
	near(w[2], 4.2);
});

test('rug: x/z scaled to the cap keep y at 3.5 cm; x capped at 8 m', () => {
	const r = clampObjectScale(RUG, [100, 1, 100], [1, 1, 1]);
	assert.equal(r.clamped, true);
	const w = worldSize(RUG, r.scale);
	near(w[1], 0.035);
	assert.ok(w[0] <= 8 + TOL && w[2] <= 8 + TOL);
	near(w[0], 8, 1e-3);
});

test('rug: shrinking y below 1 cm floors it at 1 cm (3.5 cm * 0.2 -> 0.2858 is the same as 1 cm)', () => {
	const r = clampObjectScale(RUG, [1, 0.01, 1], [1, 1, 1]);
	assert.equal(r.clamped, true);
	assert.deepEqual([r.scale[0], r.scale[2]], [1, 1]);
	near(worldSize(RUG, r.scale)[1], 0.01, 1e-3);
	assert.ok(worldSize(RUG, r.scale)[1] >= 0.01 - TOL);
});

test('rug: uniform shrink to the minimum ends at 25 cm x 1 cm x 17.5 cm (thin axis on the floor, proportions kept elsewhere)', () => {
	for (const v of [0.01, 1e-5, 0.1, 0]) {
		const r = clampObjectScale(RUG, [v, v, v], [1, 1, 1]);
		assert.equal(r.clamped, true, `v=${v}`);
		nearVec(worldSize(RUG, r.scale), [0.25, 0.01, 0.175], 1e-3);
		assert.ok(withinSizeLimits(RUG, rounded(r.scale)), `v=${v}`);
		assert.deepEqual(r.scale, [0.125, 0.2858, 0.125], `v=${v}`);
	}
});

// ---------- degenerate input ----------

test('unknown native size: NaN / zero / negative / missing / wrong length -> unchanged, clamped false', () => {
	const scale: Vec3 = [0.00001, 5000, 1];
	const bad: unknown[] = [
		[NaN, 1, 1], [1, 0, 1], [0, 0, 0], [-1, 1, 1], [Infinity, 1, 1], [1, 1], [1, 1, 1, 1],
		undefined, null, 'x', {}, [1, '1', 1],
	];
	for (const native of bad) {
		const r = clampObjectScale(native as Vec3, scale, [1, 1, 1]);
		assert.equal(r.clamped, false, JSON.stringify(native));
		assert.deepEqual(r.scale, scale, JSON.stringify(native));
	}
});

test('non-finite scale -> returned unchanged, clamped false (no throw)', () => {
	for (const s of [[NaN, 1, 1], [1, Infinity, 1], [1, 1, -Infinity]] as Vec3[]) {
		const r = clampObjectScale(CRATE, s, [1, 1, 1]);
		assert.equal(r.clamped, false);
		assert.deepEqual(r.scale, s);
	}
});

test('zero and negative scale inputs are clamped up into the limits', () => {
	for (const s of [[0, 0, 0], [-1, -1, -1], [-5, 1, 1], [0, 1, 1]] as Vec3[]) {
		const r = clampObjectScale(CRATE, s, [1, 1, 1]);
		assert.equal(r.clamped, true, JSON.stringify(s));
		assert.ok(r.scale.every((v) => v > 0), JSON.stringify(r.scale));
		assert.ok(withinSizeLimits(CRATE, rounded(r.scale)), JSON.stringify(r.scale));
		assert.ok(inScaleRange(r.scale));
	}
});

test('zero scale on every axis behaves like the uniform minimum (largest = 25 cm)', () => {
	const r = clampObjectScale(CRATE, [0, 0, 0]);
	assert.deepEqual(r.scale, [0.25, 0.25, 0.25]);
});

test('does not mutate its inputs', () => {
	const scale: Vec3 = [0.0001, 1000, 1];
	const prev: Vec3 = [1, 1, 1];
	const native: Vec3 = [0.785, 0.993, 0.967];
	clampObjectScale(native, scale, prev);
	assert.deepEqual(scale, [0.0001, 1000, 1]);
	assert.deepEqual(prev, [1, 1, 1]);
	assert.deepEqual(native, [0.785, 0.993, 0.967]);
});

// ---------- rounding / LIMITS interplay ----------

test('boundary values survive the editor rounding (roundTo, 4 dp) for awkward native sizes', () => {
	const natives: Vec3[] = [PIANO, RUG, CRATE, [0.3333, 0.7, 1.1], [0.07, 0.07, 0.07], [3, 0.123, 7.77], [1 / 3, 2 / 3, 0.9]];
	const scales: Vec3[] = [
		[1e-5, 1e-5, 1e-5], [1000, 1000, 1000], [1e-5, 1000, 1], [1, 1e-5, 1], [0.0123, 0.0123, 0.0123],
		[0.00049, 0.5, 49], [50, 50, 50], [0.001, 0.001, 0.001], [7.99999, 1, 1], [0.0001, 0.0001, 100],
	];
	for (const native of natives) {
		for (const scale of scales) {
			for (const prev of [undefined, [1, 1, 1] as Vec3]) {
				const r = clampObjectScale(native, scale, prev);
				const ctx = `native ${native} scale ${scale} prev ${prev}`;
				const after = rounded(r.scale);
				if (r.clamped) assert.deepEqual(after, r.scale, `already rounded when clamped: ${ctx}`);
				assert.ok(withinSizeLimits(native, after, TOL), `limits after roundTo: ${ctx} -> ${after}`);
				assert.ok(inScaleRange(after), `LIMITS range: ${ctx} -> ${after}`);
			}
		}
	}
});

test('pseudo-random fuzz: always inside size limits and LIMITS after rounding; idempotent', () => {
	let seed = 12345;
	const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
	const logRange = (lo: number, hi: number) => Math.exp(Math.log(lo) + rnd() * (Math.log(hi) - Math.log(lo)));
	for (let n = 0; n < 5000; n++) {
		const native: Vec3 = [logRange(0.02, 20), logRange(0.02, 20), logRange(0.02, 20)];
		const scale: Vec3 = [logRange(1e-4, 100), logRange(1e-4, 100), logRange(1e-4, 100)];
		const prev: Vec3 | undefined = rnd() < 0.5 ? undefined : [logRange(0.001, 50), logRange(0.001, 50), logRange(0.001, 50)];
		const r = clampObjectScale(native, scale, prev);
		const after = rounded(r.scale);
		const ctx = `native ${native} scale ${scale} prev ${prev} -> ${r.scale}`;
		// scale inputs beyond LIMITS are the editor's job (LIMITS clamp first); only check ones inside
		if (scale.every((v) => v >= LIMITS.minScale && v <= LIMITS.maxScale)) {
			assert.ok(withinSizeLimits(native, after, TOL), ctx);
			assert.ok(inScaleRange(after), ctx);
			// idempotent: clamping an already-clamped result changes nothing
			const again = clampObjectScale(native, r.scale, r.scale);
			assert.equal(again.clamped, false, `idempotent: ${ctx}`);
		}
		if (!r.clamped) assert.deepEqual(r.scale, scale, ctx);
	}
});

test('LIMITS wins when it conflicts with the size limits (native size tiny / huge)', () => {
	// native 0.1 mm: 1 cm would need scale 100 (> maxScale 50) -> stays within LIMITS
	const tiny: Vec3 = [0.0001, 0.0001, 0.0001];
	const t = clampObjectScale(tiny, [1, 1, 1], [1, 1, 1]);
	assert.ok(inScaleRange(t.scale));
	// native 10 km: 8 m would need scale 0.0008 (< minScale 0.001) -> stays within LIMITS
	const huge: Vec3 = [10000, 10000, 10000];
	const h = clampObjectScale(huge, [1, 1, 1], [1, 1, 1]);
	assert.ok(inScaleRange(h.scale));
});

test('the multiplier range is never exceeded even when the 25 cm minimum would ask for more (max 50)', () => {
	const small: Vec3 = [0.004, 0.004, 0.004]; // 25 cm would need scale 62.5 > LIMITS.maxScale
	const r = clampObjectScale(small, [0.001, 0.001, 0.001], [1, 1, 1]);
	assert.ok(inScaleRange(r.scale));
	assert.ok(r.scale.every((v) => v <= LIMITS.maxScale));
	// just inside: 25 cm needs scale 25 for a 1 cm model
	const ok: Vec3 = [0.01, 0.01, 0.01];
	const r2 = clampObjectScale(ok, [0.001, 0.001, 0.001], [1, 1, 1]);
	assert.equal(r2.clamped, true);
	assert.deepEqual(r2.scale, [25, 25, 25]);
});

test('uniform shrink keeps the aspect ratio for many native shapes (floor not engaged)', () => {
	const natives: Vec3[] = [PIANO, [1, 2, 3], [0.5, 0.5, 2], [3, 1, 1], [2, 0.5, 1.2], [1.2, 4.9, 1.2]];
	for (const native of natives) {
		for (const v of [1e-6, 1e-5, 0.001, 0.01, 0.05]) {
			const r = clampObjectScale(native, [v, v, v], [1, 1, 1]);
			const w = worldSize(native, r.scale);
			near(Math.max(...w), 0.25, 1e-3);
			for (let i = 0; i < 3; i++) near(w[i] / Math.max(...w), native[i] / Math.max(...native), 2e-3);
		}
	}
});

// ---------- clamped flag ----------

test('clamped flag: false for plain rounding differences, true for any real limit hit', () => {
	// 4 dp noise only -> not a clamp
	assert.equal(clampObjectScale(CRATE, [1.00001, 1, 1], [1, 1, 1]).clamped, false);
	assert.equal(clampObjectScale(CRATE, [1, 1, 1], [1, 1, 1]).clamped, false);
	// real hits
	assert.equal(clampObjectScale(CRATE, [8.5, 1, 1], [1, 1, 1]).clamped, true);
	assert.equal(clampObjectScale(CRATE, [1, 0.005, 1], [1, 1, 1]).clamped, true);
	assert.equal(clampObjectScale(CRATE, [0.05, 0.05, 0.05], [1, 1, 1]).clamped, true);
});

test('clamped result is stable: re-clamping it reports no change (no repeated hint)', () => {
	for (const s of [[1e-5, 1e-5, 1e-5], [1000, 1000, 1000], [1, 0.0001, 1]] as Vec3[]) {
		const first = clampObjectScale(PIANO, s, [1, 1, 1]);
		const second = clampObjectScale(PIANO, first.scale, first.scale);
		assert.equal(second.clamped, false);
		assert.deepEqual(second.scale, first.scale);
	}
});
