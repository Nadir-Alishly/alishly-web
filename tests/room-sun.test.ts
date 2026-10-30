// Unit tests for src/data/room-sun.ts (sun position and the shadow-only blocker above the left wall).
// Ray-vs-box (slab method) along the sun's direction. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	sunBlockerBox, wallCaps, SUN_POSITION, BLOCKER_TOP, BLOCKER_BACK_MARGIN, WALL_CAP_THICKNESS,
} from '../src/data/room-sun.ts';
import { WINDOW_OPENING, leftWallPieces, type Box } from '../src/data/room-window.ts';
import { ROOM_DIMS, ROOM_BOUNDS } from '../src/data/scene.ts';

const D = ROOM_DIMS;
const O = WINDOW_OPENING;
type V3 = [number, number, number];

// The sun is a directional light aimed at the origin, so every ray towards it runs along SUN_POSITION.
const DIR = SUN_POSITION;
const LIFT = 1e-3; // start rays just above the surface so they don't hit what they start on

/** Does the ray `from + t * dir` (t > 0) pass through the box? Slab method. */
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

/** `n` values from `a` to `b` inclusive. */
const lin = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

/** Where the ray from `p` along DIR is at x = `x` (null when it never gets there). */
function at(p: V3, x: number): V3 | null {
	const t = (x - p[0]) / DIR[0];
	return t > 0 ? [x, p[1] + t * DIR[1], p[2] + t * DIR[2]] : null;
}

const blocker = sunBlockerBox(D);
const oldBlocker = sunBlockerBox(D, 0); // the extent before the fix: back end at -half

// Top faces, 1 mm up. Right (back) wall: x -inner…half, z -half…-inner. Left wall: x -half…-inner, z -half…half.
const rightTop: V3[] = [];
for (const x of lin(-D.inner + 0.01, D.half - 0.01, 41))
	for (const z of lin(-D.half + 0.01, -D.inner - 0.01, 5)) rightTop.push([x, D.wallHeight + LIFT, z]);
const leftTop: V3[] = [];
for (const x of lin(-D.half + 0.01, -D.inner - 0.01, 3))
	for (const z of lin(-D.half + 0.01, D.half - 0.01, 41)) leftTop.push([x, D.wallHeight + LIFT, z]);

/** Floor points the sun reaches through the window: the ray crosses both faces of the left wall inside the opening. */
const patch: V3[] = [];
for (const x of lin(-D.inner + 0.1, D.half - 0.1, 25))
	for (const z of lin(-D.inner + 0.1, D.half - 0.1, 25)) {
		const p: V3 = [x, LIFT, z];
		const through = [-D.inner, -D.half].map((wx) => at(p, wx));
		const ok = through.every((q) => q && q[2] >= O.z0 && q[2] <= O.z1 && q[1] >= O.y0 && q[1] <= O.y1);
		if (ok) patch.push(p);
	}

test('blocker box: well-formed, y 3..6, same thickness as the left wall, matches the exported constants', () => {
	for (const b of [blocker, oldBlocker]) for (let i = 0; i < 3; i++) assert.ok(b.min[i] < b.max[i], `axis ${i}`);
	assert.equal(blocker.min[1], D.wallHeight);
	assert.equal(blocker.max[1], BLOCKER_TOP);
	assert.equal(BLOCKER_TOP, 6);
	assert.equal(blocker.min[0], -D.half);
	assert.equal(blocker.max[0], -D.inner);
	assert.equal(blocker.max[2], D.half); // the front end is unchanged
	assert.ok(Math.abs(blocker.min[2] - -(D.half + BLOCKER_BACK_MARGIN)) < 1e-12);
	assert.equal(oldBlocker.min[2], -D.half);
});

test('sun: position unchanged, z <= 0', () => {
	assert.deepEqual(SUN_POSITION, [-9, 4, -0.8]);
	assert.ok(SUN_POSITION[2] <= 0);
});

test('sampling covers what it claims (guards against a vacuous test)', () => {
	assert.ok(rightTop.length >= 200);
	assert.ok(leftTop.length >= 100);
	assert.ok(patch.length >= 50, `only ${patch.length} window-patch points`);
});

test('every point of the right wall top face is shadowed by the blocker', () => {
	const lit = rightTop.filter((p) => !hits(p, DIR, blocker));
	assert.deepEqual(lit, [], `${lit.length}/${rightTop.length} right-wall-top points are sun-lit, e.g. ${lit[0]}`);
});

test('every point of the left wall top face is shadowed by the blocker', () => {
	const lit = leftTop.filter((p) => !hits(p, DIR, blocker));
	assert.deepEqual(lit, [], `${lit.length}/${leftTop.length} left-wall-top points are sun-lit, e.g. ${lit[0]}`);
});

test('the blocker does not shade the floor patch the sun reaches through the window', () => {
	const blocked = patch.filter((p) => hits(p, DIR, blocker));
	assert.deepEqual(blocked, [], `${blocked.length}/${patch.length} window-patch points are blocked, e.g. ${blocked[0]}`);
});

test('regression: with the old extent (back margin 0) part of the right wall top is sun-lit', () => {
	const lit = rightTop.filter((p) => !hits(p, DIR, oldBlocker));
	assert.ok(lit.length > 0, 'the old blocker should leave the wedge lit; the test could not have caught the bug');
	// and it is the far side of the wall (the wedge is by the corner, so the lit part is away from x = -inner)
	assert.ok(lit.some((p) => p[0] > 0));
	// the lit points are all inside the new blocker's shadow
	assert.ok(lit.every((p) => hits(p, DIR, blocker)));
});

test('the new back end is what fixes it: it reaches past where the farthest ray crosses the left wall', () => {
	const far: V3 = [D.half, D.wallHeight + LIFT, -D.half];
	const q = at(far, -D.inner)!;
	assert.ok(q[2] < -D.half, 'the farthest ray drifts past the old back end');
	assert.ok(q[2] > blocker.min[2], 'and still lands inside the new one');
	assert.ok(q[1] >= blocker.min[1] && q[1] <= blocker.max[1], 'at a height inside 3..6');
});

// --- wall caps: thin light boxes on the wall tops ---

const CAPS = wallCaps(D);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;
const overlapVol = (a: Box, b: Box) =>
	[0, 1, 2].reduce((v, i) => v * Math.max(0, Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i])), 1);

test('wallCaps: each cap covers its wall top face exactly (same x/z footprint)', () => {
	const leftFace = { x: [-D.half, -D.inner], z: [-D.half, D.half] };
	const rightFace = { x: [-D.inner, D.half], z: [-D.half, -D.inner] };
	for (const [cap, face] of [[CAPS.left, leftFace], [CAPS.right, rightFace]] as const) {
		assert.ok(near(cap.min[0], face.x[0]) && near(cap.max[0], face.x[1]), `x ${cap.min[0]}..${cap.max[0]}`);
		assert.ok(near(cap.min[2], face.z[0]) && near(cap.max[2], face.z[1]), `z ${cap.min[2]}..${cap.max[2]}`);
	}
});

test('wallCaps: thickness is WALL_CAP_THICKNESS (0.03) and the bottom sits on the wall top (y = 3)', () => {
	assert.equal(WALL_CAP_THICKNESS, 0.03);
	for (const cap of [CAPS.left, CAPS.right]) {
		assert.equal(cap.min[1], D.wallHeight);
		assert.ok(near(cap.max[1] - cap.min[1], WALL_CAP_THICKNESS));
		for (let i = 0; i < 3; i++) assert.ok(cap.min[i] < cap.max[i], `axis ${i}`);
	}
	// the thickness argument is honoured
	const thick = wallCaps(D, 0.1);
	assert.ok(near(thick.left.max[1] - thick.left.min[1], 0.1));
	assert.ok(near(thick.right.max[1] - thick.right.min[1], 0.1));
});

test('wallCaps: the two caps touch at x = -inner but do not overlap', () => {
	assert.equal(overlapVol(CAPS.left, CAPS.right), 0);
	assert.equal(CAPS.left.max[0], CAPS.right.min[0]);
	assert.equal(CAPS.left.max[0], -D.inner);
	// together they span the L: back corner column belongs to the left cap only
	assert.equal(CAPS.left.min[2], -D.half);
	assert.equal(CAPS.right.min[0], -D.inner);
});
test('wallCaps: nothing below the wall top, so no intrusion into the room', () => {
	for (const cap of [CAPS.left, CAPS.right]) assert.ok(cap.min[1] >= D.wallHeight);
	// the room interior (x > -inner, z > -inner, y < wall height) is not touched
	const interior: Box = { min: [-D.inner, 0, -D.inner], max: [D.half, D.wallHeight, D.half] };
	for (const cap of [CAPS.left, CAPS.right]) assert.equal(overlapVol(cap, interior), 0);
});

test('wallCaps: the left cap sits on the actual tops of leftWallPieces (same footprint, same height)', () => {
	// the pieces whose top is the wall top: both jambs and the piece above the opening
	const tops = leftWallPieces(D).filter((b) => b.max[1] === D.wallHeight);
	assert.ok(tops.length >= 3, `${tops.length} top pieces`);
	const area = (b: Box) => (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
	for (const t of tops) {
		assert.equal(t.max[1], CAPS.left.min[1], 'cap bottom sits on the piece top');
		for (const a of [0, 2]) assert.ok(t.min[a] >= CAPS.left.min[a] - 1e-12 && t.max[a] <= CAPS.left.max[a] + 1e-12);
	}
	// they tile the cap's footprint: no overlap among them, and the areas add up to the cap's
	for (let i = 0; i < tops.length; i++)
		for (let j = i + 1; j < tops.length; j++)
			assert.equal(overlapVol({ min: [...tops[i].min.slice(0, 1), 0, tops[i].min[2]], max: [tops[i].max[0], 1, tops[i].max[2]] } as Box,
				{ min: [tops[j].min[0], 0, tops[j].min[2]], max: [tops[j].max[0], 1, tops[j].max[2]] } as Box), 0, `pieces ${i}/${j} overlap`);
	const total = tops.reduce((s, t) => s + area(t), 0);
	assert.ok(Math.abs(total - area(CAPS.left)) < 1e-9, `top pieces cover ${total}, cap ${area(CAPS.left)}`);
});

test('wallCaps: the blocker still covers the caps: rays from the cap tops cross the left wall inside its y range', () => {
	const capTop: V3[] = [];
	for (const [cap, nx, nz] of [[CAPS.left, 3, 41], [CAPS.right, 41, 3]] as const)
		for (const x of lin(cap.min[0] + 0.01, cap.max[0] - 0.01, nx))
			for (const z of lin(cap.min[2] + 0.01, cap.max[2] - 0.01, nz)) capTop.push([x, cap.max[1] + LIFT, z]);
	assert.ok(capTop.length > 200);
	assert.deepEqual(capTop.filter((p) => !hits(p, DIR, blocker)), []);
	// headroom: where the rays leave the blocker's outer face (x = -half) they are still under BLOCKER_TOP, so the lid doesn't clip them
	const highest = Math.max(...capTop.map((p) => at(p, -D.half)![1]));
	assert.ok(highest < BLOCKER_TOP - 0.05, `highest crossing ${highest} vs top ${BLOCKER_TOP}`);
	// and the right cap, like the right wall top before it, is only covered thanks to the back margin
	assert.ok(capTop.some((p) => !hits(p, DIR, oldBlocker)));
});

// Everything that can stand in the room (ROOM_BOUNDS: in front of the back walls, on the floor, under the wall top),
// e.g. a shelf hard against the back wall. The caps don't shade; the blocker is what keeps the sun off such objects.
const roomPoints: V3[] = [];
for (const x of lin(ROOM_BOUNDS.min[0], ROOM_BOUNDS.max[0], 17))
	for (const y of [0.05, 0.5, 1, 1.5, 2, 2.5, ROOM_BOUNDS.max[1]])
		for (const z of lin(ROOM_BOUNDS.min[2], ROOM_BOUNDS.max[2], 17)) roomPoints.push([x, y, z]);
// the ones whose ray goes over the left wall (crosses its plane above the wall top) instead of through the window
const overWall = roomPoints.filter((p) => {
	const q = at(p, -D.inner);
	return q !== null && q[1] > D.wallHeight;
});

test('room volume: every point whose sun ray clears the left wall top is caught by the blocker', () => {
	assert.ok(overWall.length >= 300, `only ${overWall.length} over-the-wall points`);
	// includes furniture hard against the back wall at wall height (z = -inner, y = 3), on the far side (x = half)
	assert.ok(overWall.some((p) => p[2] === -D.inner && p[1] === D.wallHeight && p[0] === D.half));
	const leaks = overWall.filter((p) => !hits(p, DIR, blocker));
	assert.deepEqual(leaks, [], `${leaks.length}/${overWall.length} points get sun over the wall, e.g. ${leaks[0]}`);
});

test('room volume: regression, with the old extent (back margin 0) sun gets over the wall near the back wall', () => {
	const leaks = overWall.filter((p) => !hits(p, DIR, oldBlocker));
	assert.ok(leaks.length > 0, 'the old blocker should leak; the test could not have caught the bug');
	// the leaks are against the back (right) wall, where rays drift furthest towards -z
	assert.ok(leaks.every((p) => p[2] < 0), 'old leaks are on the back-wall half');
	assert.ok(leaks.some((p) => p[2] === -D.inner));
});

test('room volume: the blocker leaves the window patch alone while covering everything over the wall', () => {
	// every room point is either blocked by the left wall / blocker or reaches the sun only through the opening
	for (const p of roomPoints) {
		const q = at(p, -D.inner);
		if (!q) continue;
		const inOpening = q[2] >= O.z0 && q[2] <= O.z1 && q[1] >= O.y0 && q[1] <= O.y1;
		if (inOpening) assert.ok(!hits(p, DIR, blocker), `blocker shades window light at ${p}`);
	}
});
