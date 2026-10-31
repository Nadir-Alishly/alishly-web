// Sweep of the whole sun slider domain (SETTING_RANGES.sun azimuth x elevation) with the ray-vs-box harness of
// tests/room-sun.test.ts: sunlight must enter the room ONLY through the window, whatever the sliders say.
// Also covers sunBlockerFor. Widening SETTING_RANGES.sun makes this sweep cover the wider domain automatically.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunBlockerBox, sunBlockerFor, wallCaps, SUN_POSITION, BLOCKER_TOP, BLOCKER_BACK_MARGIN } from '../src/data/room-sun.ts';
import { sunPatch } from '../src/data/room-glow.ts';
import { WINDOW_OPENING as O, leftWallPieces, windowFrame, type Box } from '../src/data/room-window.ts';
import { ROOM_DIMS as D, ROOM_BOUNDS } from '../src/data/scene.ts';
import { SETTING_RANGES, DEFAULT_SETTINGS, sunDirection } from '../src/data/scene-settings.ts';

type V3 = [number, number, number];
const LIFT = 1e-3;
/** Light must stay at least this far in front of every corner of room + blocker (mirrors SUN_CLEARANCE of room-core). */
const SUN_CLEARANCE = 2;

/** Does the ray `from + t * dir` (t > 0) pass through the box? Slab method (same as tests/room-sun.test.ts). */
function hits(from: V3, dir: V3, b: Box): boolean {
	let t0 = 0;
	let t1 = Infinity;
	for (let i = 0; i < 3; i++) {
		if (Math.abs(dir[i]) < 1e-12) {
			if (from[i] < b.min[i] || from[i] > b.max[i]) return false;
			continue;
		}
		let a = (b.min[i] - from[i]) / dir[i];
		let c = (b.max[i] - from[i]) / dir[i];
		if (a > c) [a, c] = [c, a];
		t0 = Math.max(t0, a);
		t1 = Math.min(t1, c);
		if (t0 > t1) return false;
	}
	return true;
}
const lin = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
/** Where the ray from `p` towards the sun is at x = wx (null when it never gets there). */
const at = (p: V3, dir: V3, wx: number): V3 | null => {
	const t = (wx - p[0]) / dir[0];
	return t > -1e-9 ? [wx, p[1] + t * dir[1], p[2] + t * dir[2]] : null;
};
const inOpening = (q: V3 | null, eps = 0) => !!q && q[2] >= O.z0 - eps && q[2] <= O.z1 + eps && q[1] >= O.y0 - eps && q[1] <= O.y1 + eps;

const win = windowFrame(D);
const solids: Box[] = [
	...leftWallPieces(D),
	{ min: [-D.inner, 0, -D.half], max: [D.half, D.wallHeight, -D.inner] }, // right (back) wall
	win.sill, ...win.frame, ...win.muntins,
];
const caps = wallCaps(D);

// Wall tops and cap tops (they must be in the blocker's shade), and the room volume (nothing may be lit except via the window).
const tops: V3[] = [];
for (const x of lin(-D.inner + 0.01, D.half - 0.01, 41)) for (const z of lin(-D.half + 0.01, -D.inner - 0.01, 5)) tops.push([x, D.wallHeight + LIFT, z]);
for (const x of lin(-D.half + 0.01, -D.inner - 0.01, 3)) for (const z of lin(-D.half + 0.01, D.half - 0.01, 41)) tops.push([x, D.wallHeight + LIFT, z]);
for (const cap of [caps.left, caps.right]) {
	for (const x of lin(cap.min[0] + 0.01, cap.max[0] - 0.01, 41)) for (const z of lin(cap.min[2] + 0.01, cap.max[2] - 0.01, 41)) tops.push([x, cap.max[1] + LIFT, z]);
}
const volume: V3[] = [];
for (const x of lin(ROOM_BOUNDS.min[0], ROOM_BOUNDS.max[0], 25)) {
	for (const y of [0.001, 0.25, 0.5, 1, 1.5, 2, 2.5, ROOM_BOUNDS.max[1]]) {
		for (const z of lin(ROOM_BOUNDS.min[2], ROOM_BOUNDS.max[2], 25)) volume.push([x, y, z]);
	}
}

const azR = SETTING_RANGES.sun.azimuth;
const elR = SETTING_RANGES.sun.elevation;
/** 31 x 26 grid over the domain: every 1 degree of azimuth and 1 degree of elevation for the shipped range. */
const AZS = lin(azR.min, azR.max, Math.round(azR.max - azR.min) + 1);
const ELS = lin(elR.min, elR.max, Math.round(elR.max - elR.min) + 1);

// ---------------------------------------------------------------------------------------------------------------

test('sunBlockerFor at the default sun is exactly the original blocker box (default rendering unchanged)', () => {
	const dflt = sunDirection(DEFAULT_SETTINGS.sun.azimuth, DEFAULT_SETTINGS.sun.elevation);
	assert.deepEqual(sunBlockerFor(D, dflt), sunBlockerBox(D));
	assert.deepEqual(sunBlockerFor(D, SUN_POSITION), sunBlockerBox(D));
	assert.deepEqual(sunBlockerBox(D), { min: [-D.half, D.wallHeight, -(D.half + BLOCKER_BACK_MARGIN)], max: [-D.inner, BLOCKER_TOP, D.half] });
});

test('sunBlockerFor: never smaller than the original box, grows monotonically with azimuth and elevation, rejects bad suns', () => {
	const base = sunBlockerBox(D);
	let prevMargin = -Infinity;
	for (const az of AZS) {
		const b = sunBlockerFor(D, sunDirection(az, 25));
		assert.ok(b.min[2] <= base.min[2] + 1e-12 && b.max[1] >= base.max[1] - 1e-12, `az ${az}`);
		assert.ok(-b.min[2] >= prevMargin - 1e-12, 'back end reaches further back as the sun swings round');
		prevMargin = -b.min[2];
		assert.deepEqual([b.min[0], b.max[0], b.min[1], b.max[2]], [base.min[0], base.max[0], base.min[1], base.max[2]], 'x range, base and front end are fixed');
	}
	let prevTop = -Infinity;
	for (const el of ELS) {
		const b = sunBlockerFor(D, sunDirection(10, el));
		assert.ok(b.max[1] >= prevTop - 1e-12, 'higher sun needs a taller blocker');
		prevTop = b.max[1];
	}
	for (const bad of [[1, 4, 0], [0, 4, 0], [-9, 0, 0], [-9, -1, 0]] as V3[]) assert.throws(() => sunBlockerFor(D, bad), RangeError, JSON.stringify(bad));
});

test('sunDirection stays in the domain for any input (so a bad value can never leave the swept domain)', () => {
	for (const az of [-1e9, -1, 0, 15, 30, 31, 1e9]) for (const el of [-1e9, 14.9, 15, 27, 40, 40.1, 1e9]) {
		const d = sunDirection(az, el);
		const swept = sunDirection(Math.min(azR.max, Math.max(azR.min, az)), Math.min(elR.max, Math.max(elR.min, el)));
		assert.deepEqual(d, swept, `az ${az} el ${el}`);
	}
});

test('sun domain sweep: wall tops are shaded, the window patch is never blocked, nothing leaks over the walls', () => {
	let combos = 0;
	let litFloorMin = Infinity;
	let maxPushed = 0;
	const failures: string[] = [];
	const fail = (az: number, el: number, what: string) => { if (failures.length < 12) failures.push(`az ${az} el ${el}: ${what}`); else if (failures.length === 12) failures.push('…'); };

	for (const az of AZS) for (const el of ELS) {
		combos++;
		const dir = sunDirection(az, el);
		const blocker = sunBlockerFor(D, dir);
		const all: Box[] = [...solids, blocker];

		// 1. every wall-top / cap-top point lies in the blocker's shade (the blocker itself, not just any solid)
		for (const p of tops) if (!hits(p, dir, blocker)) { fail(az, el, `top point ${p} is not shaded by the blocker`); break; }

		// 2. nothing in the room volume is lit except through the window opening (checked on both faces of the left wall)
		let leak: V3 | null = null;
		let litOnFloor = 0;
		for (const p of volume) {
			if (all.some((b) => hits(p, dir, b))) continue; // shaded
			if (!(inOpening(at(p, dir, -D.inner), 1e-9) && inOpening(at(p, dir, -D.half), 1e-9))) { leak = p; break; }
			if (p[1] <= 0.002) litOnFloor++;
		}
		if (leak) fail(az, el, `sunlight leaks to ${leak}`);
		litFloorMin = Math.min(litFloorMin, litOnFloor);

		// 3. the blocker never shades a point that sees the sun through the window
		for (const p of volume) {
			if (inOpening(at(p, dir, -D.inner)) && inOpening(at(p, dir, -D.half)) && hits(p, dir, blocker)) { fail(az, el, `the blocker shades window light at ${p}`); break; }
		}

		// 4. shadow camera: the light (pushed back like room-core does) stays in front of every corner of room + blocker
		const len = Math.hypot(...dir);
		const u = dir.map((c) => c / len);
		const lo = [-D.half - 0.3, -D.slab - 0.3, -D.half - 0.3].map((c, i) => Math.min(c, blocker.min[i]));
		const hi = [D.half + 0.3, D.wallHeight + 0.3, D.half + 0.3].map((c, i) => Math.max(c, blocker.max[i]));
		let depth = -Infinity;
		for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) depth = Math.max(depth, x * u[0] + y * u[1] + z * u[2]);
		const needed = Math.max(len, depth + SUN_CLEARANCE);
		if (!Number.isFinite(needed) || needed > 20) fail(az, el, `the light would have to sit ${needed.toFixed(1)} units away`);
		if (depth > len) maxPushed = Math.max(maxPushed, needed);

		// 5. the window patch exists on the floor and does not lie entirely past the slab
		const xs = sunPatch(D, O, dir).map((q) => q[0]);
		if (Math.min(...xs) > D.half) fail(az, el, 'window patch entirely past the floor edge');
	}
	assert.equal(combos, AZS.length * ELS.length);
	assert.ok(combos >= 800, `swept ${combos} combinations`);
	assert.deepEqual(failures, []);
	assert.ok(maxPushed >= 0);
	assert.ok(litFloorMin >= 10, `a lit patch remains on the floor everywhere in the domain (min ${litFloorMin} samples)`);
});

test('sun domain sweep: the four corners and the default are in the grid, and the harness does detect a leak (negative control)', () => {
	for (const [az, el] of [[azR.min, elR.min], [azR.max, elR.max], [azR.min, elR.max], [azR.max, elR.min]]) {
		assert.ok(AZS.includes(az) && ELS.includes(el), `corner ${az}/${el}`);
	}
	// negative control: the ORIGINAL fixed blocker leaks over the wall tops somewhere in the domain
	const fixed = sunBlockerBox(D);
	let leaking = 0;
	for (const az of AZS) for (const el of ELS) {
		const dir = sunDirection(az, el);
		if (tops.some((p) => !hits(p, dir, fixed))) leaking++;
	}
	assert.ok(leaking > 0, 'the fixed default blocker is not enough for the whole domain (so the derived blocker is needed)');
	// and a blocker that is too small is caught by check 1: a sun outside the domain with the blocker for the domain edge
	const corner = sunDirection(azR.max, elR.max);
	const wide: V3 = [-9 * 0.5, 9, -9 * 0.8];
	assert.ok(tops.some((p) => !hits(p, wide, sunBlockerFor(D, corner))), 'a sun beyond the domain would leak, which is why the sliders are clamped');
});
