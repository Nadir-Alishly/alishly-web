// Unit tests for src/data/room-uv.ts (world-space box UVs for the stucco walls). Run: node --test tests/
// The geometry comes from three's real BoxGeometry (the same vertex layout room-core.ts uses), translated to world space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { worldUv, boxUvs } from '../src/data/room-uv.ts';
import { leftWallPieces, type Box } from '../src/data/room-window.ts';
import { wallCaps } from '../src/data/room-sun.ts';
import { ROOM_DIMS } from '../src/data/scene.ts';

const TILE = 2;
// BoxGeometry stores float32 positions (1.1 -> 1.10000002), so coincident vertices agree to ~1e-7, not exactly.
const EPS = 1e-6;
const near = (a: readonly number[], b: readonly number[], msg: string) => {
	assert.equal(a.length, b.length, msg);
	a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < EPS, `${msg}: ${a} vs ${b}`));
};
type V3 = [number, number, number];

/** What room-core.ts's wallBox() builds: a box translated to its place, with the UVs overwritten by boxUvs(). */
function wallGeometry(b: Box, tile = TILE) {
	const size = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
	const centre = [0, 1, 2].map((i) => (b.max[i] + b.min[i]) / 2);
	const g = new BoxGeometry(size[0], size[1], size[2]).translate(centre[0], centre[1], centre[2]);
	const pos = g.attributes.position.array;
	const nor = g.attributes.normal.array;
	const uv = boxUvs(pos, nor, tile);
	return { pos, nor, uv, index: g.index!.array };
}

const vertexOf = (g: ReturnType<typeof wallGeometry>, i: number) => ({
	p: [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]] as V3,
	n: [g.nor[i * 3], g.nor[i * 3 + 1], g.nor[i * 3 + 2]] as V3,
	uv: [g.uv[i * 2], g.uv[i * 2 + 1]] as [number, number],
});

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Tangent (d position / du) and bitangent (d position / dv) of a triangle, the frame three builds a normal map's TBN from. */
function frame(a: ReturnType<typeof vertexOf>, b: ReturnType<typeof vertexOf>, c: ReturnType<typeof vertexOf>) {
	const e1 = sub(b.p, a.p);
	const e2 = sub(c.p, a.p);
	const du1 = b.uv[0] - a.uv[0], dv1 = b.uv[1] - a.uv[1];
	const du2 = c.uv[0] - a.uv[0], dv2 = c.uv[1] - a.uv[1];
	const det = du1 * dv2 - du2 * dv1;
	const T = [0, 1, 2].map((i) => (e1[i] * dv2 - e2[i] * dv1) / det) as V3;
	const B = [0, 1, 2].map((i) => (e2[i] * du1 - e1[i] * du2) / det) as V3;
	return { T, B, det };
}

test('worldUv: each face projects along its dominant normal axis', () => {
	// +x (the left wall's inner face): u runs along -z (so it points right as seen from +x), v is height
	assert.deepEqual(worldUv([1, 0, 0], [-3, 1, 0.5], 1), [-0.5, 1]);
	assert.deepEqual(worldUv([-1, 0, 0], [-3.2, 1, 0.5], 1), [0.5, 1]);
	// +z (the right wall's inner face): u runs along +x
	assert.deepEqual(worldUv([0, 0, 1], [0.5, 1, -3], 1), [0.5, 1]);
	assert.deepEqual(worldUv([0, 0, -1], [0.5, 1, -3.2], 1), [-0.5, 1]);
	// +y (caps): u along x, v along -z
	assert.deepEqual(worldUv([0, 1, 0], [0.5, 3.03, 0.25], 1), [0.5, -0.25]);
	assert.deepEqual(worldUv([0, -1, 0], [0.5, 0, 0.25], 1), [0.5, 0.25]);
});

test('worldUv: tile is the world length of one repeat, and every projection scales with it', () => {
	for (const n of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]] as V3[]) {
		const p: V3 = [1.3, 0.7, -2.1];
		const a = worldUv(n, p, 1);
		const b = worldUv(n, p, 2);
		const c = worldUv(n, p, 0.5);
		assert.ok(Math.abs(b[0] - a[0] / 2) < EPS && Math.abs(b[1] - a[1] / 2) < EPS, `tile 2 halves ${n}`);
		assert.ok(Math.abs(c[0] - a[0] * 2) < EPS && Math.abs(c[1] - a[1] * 2) < EPS, `tile 0.5 doubles ${n}`);
	}
	// moving by exactly one tile along a face moves the UV by exactly 1
	const a = worldUv([0, 0, 1], [0, 0, -3], TILE);
	const b = worldUv([0, 0, 1], [TILE, 0, -3], TILE);
	const c = worldUv([0, 0, 1], [0, TILE, -3], TILE);
	near([b[0] - a[0], b[1] - a[1]], [1, 0], 'one tile along x');
	near([c[0] - a[0], c[1] - a[1]], [0, 1], 'one tile up');
});

test('worldUv: depends only on the position along the face, not on the offset along the normal', () => {
	assert.deepEqual(worldUv([1, 0, 0], [-3, 1, 0.5], 2), worldUv([1, 0, 0], [99, 1, 0.5], 2));
	assert.deepEqual(worldUv([0, 0, 1], [0.5, 1, -3], 2), worldUv([0, 0, 1], [0.5, 1, 7], 2));
	assert.deepEqual(worldUv([0, 1, 0], [0.5, 3, 0.25], 2), worldUv([0, 1, 0], [0.5, -4, 0.25], 2));
});

test('boxUvs: returns 2 numbers per vertex, rejects bad input', () => {
	const g = wallGeometry({ min: [-3.2, 0, -3.2], max: [-3, 3, -1.1] });
	assert.equal(g.uv.length / 2, g.pos.length / 3);
	assert.equal(g.uv.length / 2, 24, 'a BoxGeometry has 24 vertices');
	assert.throws(() => boxUvs([0, 0, 0], [0, 0, 0], 0), RangeError);
	assert.throws(() => boxUvs([0, 0, 0], [0, 0, 0], -1), RangeError);
	assert.throws(() => boxUvs([0, 0, 0], [0, 0, 0, 0, 0, 0], 1), RangeError);
	assert.throws(() => boxUvs([0, 0], [0, 0], 1), RangeError);
	assert.deepEqual(boxUvs([], [], 1), []);
});

const ALL: [string, Box][] = [
	...leftWallPieces(ROOM_DIMS).map((b, i) => [`left piece ${i}`, b] as [string, Box]),
	['right wall', { min: [-ROOM_DIMS.inner, 0, -ROOM_DIMS.half], max: [ROOM_DIMS.half, ROOM_DIMS.wallHeight, -ROOM_DIMS.inner] }],
	['left cap', wallCaps(ROOM_DIMS).left],
	['right cap', wallCaps(ROOM_DIMS).right],
];

test('boxUvs: no triangle is mirrored on any face of any wall piece or cap (normal-map tangent frame is right-handed)', () => {
	for (const [name, box] of ALL) {
		const g = wallGeometry(box);
		assert.equal(g.index.length, 36);
		for (let t = 0; t < g.index.length; t += 3) {
			const [a, b, c] = [0, 1, 2].map((k) => vertexOf(g, g.index[t + k]));
			const { T, B, det } = frame(a, b, c);
			assert.ok(Math.abs(det) > 1e-9, `${name}: triangle ${t / 3} has non-degenerate UVs`);
			assert.ok(dot(cross(T, B), a.n) > 0, `${name}: triangle ${t / 3} (normal ${a.n}) is mirrored`);
			// tangent and bitangent are unit-ish world vectors scaled by TILE, and lie in the face plane
			assert.ok(Math.abs(dot(T, a.n)) < 1e-6 && Math.abs(dot(B, a.n)) < 1e-6, `${name}: frame lies in the face plane`);
			assert.ok(Math.abs(Math.hypot(...T) - TILE) < 1e-6 && Math.abs(Math.hypot(...B) - TILE) < 1e-6, `${name}: UV scale is 1 / TILE`);
		}
	}
});

test('boxUvs: on every visible face v is up (+y) and u runs to the right as seen from outside', () => {
	for (const [name, box] of ALL) {
		const g = wallGeometry(box);
		for (let t = 0; t < g.index.length; t += 3) {
			const [a, b, c] = [0, 1, 2].map((k) => vertexOf(g, g.index[t + k]));
			const { T, B } = frame(a, b, c);
			const [nx, ny, nz] = a.n;
			if (ny === 0) {
				assert.ok(B[1] > 0 && Math.abs(B[0]) + Math.abs(B[2]) < 1e-6, `${name}: v points up on a side face ${a.n}`);
				// viewed from outside (looking against the normal) with +y up, "right" is up x normal ... = cross(y, n)... u must follow it
				const right = cross([0, 1, 0], [nx, ny, nz]);
				assert.ok(dot(T, right) > 0, `${name}: u runs to the right as seen from outside on ${a.n}`);
			} else {
				// top / bottom: right-handed about the outward normal
				assert.ok(dot(cross(T, B), a.n) > 0, `${name}: top/bottom face ${a.n}`);
			}
		}
	}
});

test('boxUvs: independent of box size and position: a vertex gets worldUv(its position) whatever box it belongs to', () => {
	for (const [name, box] of ALL) {
		const g = wallGeometry(box);
		for (let i = 0; i < g.pos.length / 3; i++) {
			const v = vertexOf(g, i);
			const expected = worldUv(v.n, v.p, TILE);
			near(v.uv, expected, `${name} vertex ${i}`);
		}
	}
	// the same wall plane cut into different boxes gives the same field
	const whole = wallGeometry({ min: [-3.2, 0, -3.2], max: [-3, 3, 3.2] });
	const half = wallGeometry({ min: [-3.2, 0, 0], max: [-3, 1.5, 3.2] });
	const at = (g: ReturnType<typeof wallGeometry>, p: V3) => {
		for (let i = 0; i < g.pos.length / 3; i++) {
			const v = vertexOf(g, i);
			if (v.n[0] === 1 && v.p.every((c, k) => Math.abs(c - p[k]) < EPS)) return v.uv;
		}
	};
	const p: V3 = [-3, 1.5, 3.2];
	near(at(whole, [-3, 3, 3.2])!, [-3.2 / TILE, 3 / TILE], 'whole wall corner');
	near(at(half, p)!, at(wallGeometry({ min: [-3.2, 1.5, 0], max: [-3, 3, 3.2] }), p)!, 'same point from two boxes');
});

test('continuity: the adjacent pieces of the left wall (jambs, below/above the window) share one UV field on the inner face', () => {
	// Every inner-face (+x) vertex of every piece, keyed by its world position: coincident vertices must have the same UV.
	const seen = new Map<string, [number, number]>();
	let shared = 0;
	for (const b of leftWallPieces(ROOM_DIMS)) {
		const g = wallGeometry(b);
		for (let i = 0; i < g.pos.length / 3; i++) {
			const v = vertexOf(g, i);
			if (v.n[0] !== 1) continue;
			const key = v.p.map((c) => c.toFixed(4)).join();
			const prev = seen.get(key);
			if (prev) {
				shared++;
				near(prev, v.uv, `UV jump at ${key}`);
			}
			seen.set(key, v.uv);
		}
	}
	// back/front jamb meet the below and above pieces at 4 corners each side of the opening (the others are T-junctions,
	// where UV = worldUv(position) is what keeps the field continuous; see the next tests)
	assert.ok(shared >= 4, `the pieces do touch (${shared} shared corners)`);
});

test('continuity: across the window opening a point on the front jamb continues the back jamb\'s u (no restart, no gap)', () => {
	const [back, front] = leftWallPieces(ROOM_DIMS);
	const uAt = (b: Box, z: number) => worldUv([1, 0, 0], [b.min[0], 1, z], TILE)[0];
	// u changes by exactly (distance)/tile going from the back jamb edge to the front jamb edge
	const du = uAt(front, front.min[2]) - uAt(back, back.max[2]);
	assert.ok(Math.abs(du + (front.min[2] - back.max[2]) / TILE) < EPS);
	// below/above the opening: same u as the jamb at the same z, same v as the jambs at the same y
	const [, , below, above] = leftWallPieces(ROOM_DIMS);
	const gB = wallGeometry(below);
	const gJ = wallGeometry(back);
	const corner = (g: ReturnType<typeof wallGeometry>, p: V3) => {
		for (let i = 0; i < g.pos.length / 3; i++) {
			const v = vertexOf(g, i);
			if (v.n[0] === 1 && v.p.every((c, k) => Math.abs(c - p[k]) < EPS)) return v.uv;
		}
		throw new Error(`no corner ${p}`);
	};
	near(corner(gB, [-3, below.max[1], below.min[2]]), worldUv([1, 0, 0], [-3, below.max[1], below.min[2]], TILE), 'below-piece top corner');
	near(corner(gB, [-3, 0, below.min[2]]), corner(gJ, [-3, 0, back.max[2]]), 'bottom edge: below-piece corner == jamb corner');
	assert.ok(above.min[1] > below.max[1]);
});

test('continuity: wall face and cap side across y = wall height (same plane, v goes on up, u unchanged)', () => {
	const { left, right } = wallCaps(ROOM_DIMS);
	const leftWall = leftWallPieces(ROOM_DIMS)[0];
	const rightWall: Box = { min: [-ROOM_DIMS.inner, 0, -ROOM_DIMS.half], max: [ROOM_DIMS.half, ROOM_DIMS.wallHeight, -ROOM_DIMS.inner] };
	for (const [wall, cap, n, name] of [[leftWall, left, [1, 0, 0], 'left'], [rightWall, right, [0, 0, 1], 'right']] as [Box, Box, V3, string][]) {
		const gw = wallGeometry(wall);
		const gc = wallGeometry(cap);
		const top = (g: ReturnType<typeof wallGeometry>, y: number) => {
			const out: ReturnType<typeof vertexOf>[] = [];
			for (let i = 0; i < g.pos.length / 3; i++) {
				const v = vertexOf(g, i);
				if (v.n.every((c, k) => c === n[k]) && Math.abs(v.p[1] - y) < EPS) out.push(v);
			}
			return out;
		};
		const wallTop = top(gw, ROOM_DIMS.wallHeight);
		const capBottom = top(gc, ROOM_DIMS.wallHeight);
		assert.equal(wallTop.length, 2);
		assert.equal(capBottom.length, 2);
		let matched = 0;
		for (const w of wallTop) {
			const c = capBottom.find((v) => v.p.every((x, k) => Math.abs(x - w.p[k]) < EPS));
			if (!c) continue; // the left wall's top-front corner at the window jamb is not a cap vertex (the cap spans the whole wall)
			matched++;
			near(c.uv, w.uv, `${name}: UV matches across the wall/cap line at ${w.p}`);
		}
		assert.ok(matched >= 1, `${name}: wall and cap share at least one corner`);
		// and the cap's bottom edge is exactly where worldUv puts a wall-top point, at any z along it
		for (const c of capBottom) near(c.uv, worldUv(n, c.p, TILE), `${name}: cap bottom edge on the wall's field`);
		// the cap's top edge is `thickness` further up in v
		const capTop = top(gc, ROOM_DIMS.wallHeight + 0.03);
		assert.ok(capTop.every((v) => v.uv[1] > wallTop[0].uv[1]), `${name}: v keeps rising up the cap`);
	}
});

test('continuity: the two cap tops meet at x = -inner with the same UV (the +y field is one sheet)', () => {
	const { left, right } = wallCaps(ROOM_DIMS);
	const tops = [left, right].map((b) => {
		const g = wallGeometry(b);
		const out = new Map<string, [number, number]>();
		for (let i = 0; i < g.pos.length / 3; i++) {
			const v = vertexOf(g, i);
			if (v.n[1] === 1) out.set(v.p.map((c) => c.toFixed(4)).join(), v.uv);
		}
		return out;
	});
	let shared = 0;
	for (const [k, uv] of tops[0]) {
		const other = tops[1].get(k);
		if (other) { shared++; near(other, uv, `cap UV at ${k}`); }
	}
	assert.ok(shared >= 1, 'the caps share a corner at (-inner, top, -inner)');
});
