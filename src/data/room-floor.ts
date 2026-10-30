// Plank layout of the wooden floor texture. Pure TypeScript with only erasable syntax and no DOM/three/Astro
// imports, so Node can import it directly (`node --test`). room-core.ts paints the planks onto a canvas.
//
// The layout lives in unit space: u (0..1) runs along the planks, v (0..1) across the rows. One texture tile covers
// the whole floor top, so nothing repeats visibly. Each row is cut into planks that cover 0..1 exactly (no gaps, no
// overlaps); the end joints of neighbouring rows are staggered.

/** Seeded PRNG (mulberry32): same seed, same sequence, floats in [0, 1). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface FloorPlankSpec {
	/** World size of the floor top the tile covers (it is square). */
	size: number;
	/** Plank width across the row, world units. The row count is size / width, rounded. */
	width: number;
	/** Shortest and longest plank, world units. */
	minLength: number;
	maxLength: number;
	/** Neighbouring rows keep their end joints at least this far apart, world units. */
	minStagger: number;
	seed: number;
}

export const FLOOR_PLANKS: FloorPlankSpec = {
	size: 6.4,
	width: 0.4,
	minLength: 1.4,
	maxLength: 3.0,
	minStagger: 0.35,
	seed: 20261030,
};

export interface Plank {
	row: number;
	/** Start and end along the row, in 0..1. */
	u0: number;
	u1: number;
	/** Per-plank tone variation in -1..1. */
	tone: number;
}

export interface PlankLayout {
	rows: number;
	planks: Plank[];
}

/** Joints (plank boundaries strictly inside 0..1) of the given planks. */
const joints = (planks: readonly Plank[]) => planks.slice(1).map((p) => p.u0);

/** One row cut into planks; `u` values are in 0..1. Retries a few times so the joints keep clear of `avoid`. */
function layRow(
	row: number,
	spec: FloorPlankSpec,
	rand: () => number,
	avoid: readonly number[],
): Plank[] {
	const minLen = spec.minLength / spec.size;
	const maxLen = spec.maxLength / spec.size;
	const clear = spec.minStagger / spec.size;
	let best: Plank[] = [];
	let bestScore = -1;
	for (let attempt = 0; attempt < 24; attempt++) {
		const planks: Plank[] = [];
		let at = 0;
		let first = true;
		while (at < 1 - 1e-9) {
			// The first plank is a random cut-off of a full one, which staggers the rows.
			let len = minLen + rand() * (maxLen - minLen);
			if (first) len = Math.max(0.5 * minLen, len * rand());
			first = false;
			let end = at + len;
			// No sliver at the end: absorb it into this plank.
			if (1 - end < minLen * 0.5) end = 1;
			end = Math.min(end, 1);
			planks.push({ row, u0: at, u1: end, tone: rand() * 2 - 1 });
			at = end;
		}
		const js = joints(planks);
		const gap = Math.min(...js.map((j) => Math.min(...avoid.map((a) => Math.abs(j - a)), Infinity)), Infinity);
		const score = js.length === 0 ? Infinity : gap;
		if (score > bestScore) {
			best = planks;
			bestScore = score;
		}
		if (score >= clear) break;
	}
	return best;
}

/** Deterministic plank layout for the floor: same spec, same planks. */
export function plankLayout(spec: FloorPlankSpec = FLOOR_PLANKS): PlankLayout {
	const rows = Math.max(1, Math.round(spec.size / spec.width));
	const rand = mulberry32(spec.seed);
	const planks: Plank[] = [];
	let previous: number[] = [];
	for (let row = 0; row < rows; row++) {
		const laid = layRow(row, spec, rand, previous);
		previous = joints(laid);
		planks.push(...laid);
	}
	return { rows, planks };
}
