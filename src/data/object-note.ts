// Pure logic of the public room's object notes (title + paragraph): which objects are interactive, which one is
// highlighted, click vs drag, the hover float and where the popup goes.
// Pure TypeScript with only erasable syntax and no imports (no DOM/three/Astro), so Node can import it directly
// (`node --test`). The DOM/three wiring lives in scripts/room-interact.ts.

/** The only fields of a scene object that the notes need. */
export interface NoteSource {
	id: string;
	type: string;
	title?: string;
	paragraph?: string;
}

export interface NoteEntry {
	id: string;
	title: string | null;
	paragraph: string;
	/** What names the object: its title, else the catalog label (else the raw type). */
	label: string;
}

/** Only a non-empty paragraph makes an object interactive; a title alone does nothing. */
export function hasNote(object: { paragraph?: unknown }): boolean {
	return typeof object.paragraph === 'string' && object.paragraph.trim() !== '';
}

/**
 * The interactive objects, in scene order. `labelOf(type)` is the catalog label (undefined when unknown).
 * Notes that would get the same label are numbered from 1 in scene order ("Chair 1", "Chair 2"), so the keyboard list
 * never offers two identical buttons; a label that occurs once stays plain.
 */
export function collectNotes(
	objects: readonly NoteSource[],
	labelOf: (type: string) => string | undefined,
): NoteEntry[] {
	const out: NoteEntry[] = [];
	for (const object of objects) {
		if (!hasNote(object)) continue;
		const title = typeof object.title === 'string' && object.title.trim() !== '' ? object.title : null;
		out.push({
			id: object.id,
			title,
			paragraph: object.paragraph as string,
			label: title ?? labelOf(object.type) ?? object.type,
		});
	}
	const totals = new Map<string, number>();
	for (const entry of out) totals.set(entry.label, (totals.get(entry.label) ?? 0) + 1);
	const seen = new Map<string, number>();
	for (const entry of out) {
		if ((totals.get(entry.label) ?? 0) < 2) continue;
		const n = (seen.get(entry.label) ?? 0) + 1;
		seen.set(entry.label, n);
		entry.label = `${entry.label} ${n}`;
	}
	return out;
}

/** Accessible name of a keyboard-list button: "Chair — read note". */
export function noteButtonLabel(entry: Pick<NoteEntry, 'label'>): string {
	return `${entry.label} — read note`;
}

/** Hover takes over: the hovered note object is highlighted, else the selected one, else none. Never two. */
export function highlightedId(hoverId: string | null, selectedId: string | null): string | null {
	return hoverId ?? selectedId;
}

/** A pointer interaction is a click (not an orbit drag) when it moved less than `slop` px from where it started. */
export function isClick(down: { x: number; y: number }, up: { x: number; y: number }, slop: number): boolean {
	return Math.hypot(up.x - down.x, up.y - down.y) < slop;
}

/** Narrow screens (< 640 px, Tailwind's `sm`) get a bottom sheet instead of an anchored popup. */
export const SHEET_BREAKPOINT = 640;
export const isNarrow = (width: number): boolean => width < SHEET_BREAKPOINT;

// --- Hover float -----------------------------------------------------------------------------

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/**
 * Moves a 0..1 progress value towards `target` (0 or 1) at 1 / `durationMs` per millisecond. Works from wherever
 * it is, so reversing mid-float simply turns around. With `durationMs <= 0` it jumps.
 */
export function advanceProgress(progress: number, target: number, dtMs: number, durationMs: number): number {
	if (durationMs <= 0) return target;
	const step = Math.max(0, dtMs) / durationMs;
	if (progress < target) return Math.min(target, progress + step);
	if (progress > target) return Math.max(target, progress - step);
	return target;
}

// --- Popup placement ----------------------------------------------------------------------------

export interface PlaceInput {
	/** The object on screen, relative to the canvas: horizontal centre, top edge and bottom edge (px, y grows downwards). */
	anchor: { x: number; top: number; bottom: number };
	/** The popup at its natural size (its height unconstrained, capped by the caller if it wants a ceiling). */
	size: { width: number; height: number };
	/** The canvas. */
	bounds: { width: number; height: number };
	/** Keep this far from the canvas edges. */
	margin: number;
	/** Space between the object and the popup. */
	gap: number;
}

export interface Placement {
	/** Top-left corner of the popup, relative to the canvas. */
	left: number;
	top: number;
	/** The popup's height after fitting; smaller than the natural height when the text has to scroll inside. */
	height: number;
	/** `above` the object, flipped `below` it, or `over` it when neither side has usable room. */
	placement: 'above' | 'below' | 'over';
}

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), Math.max(lo, hi));

/** Keeps the popup inside the canvas, above the object when it fits, else below, else on the roomier side (scrolling). */
export function placePopup(input: PlaceInput): Placement {
	const { anchor, size, bounds, margin, gap } = input;
	const width = Math.min(size.width, Math.max(0, bounds.width - 2 * margin));
	const left = clamp(anchor.x - width / 2, margin, bounds.width - margin - width);
	const full = Math.min(size.height, Math.max(0, bounds.height - 2 * margin));
	const roomAbove = anchor.top - gap - margin;
	const roomBelow = bounds.height - margin - (anchor.bottom + gap);

	if (full <= roomAbove) return { left, top: anchor.top - gap - full, height: full, placement: 'above' };
	if (full <= roomBelow) return { left, top: anchor.bottom + gap, height: full, placement: 'below' };

	// Neither side fits the whole popup: use the roomier side and let the text scroll, unless that is too small to read.
	const MIN_USABLE = 120;
	const aboveRoomier = roomAbove >= roomBelow;
	const room = aboveRoomier ? roomAbove : roomBelow;
	if (room >= Math.min(MIN_USABLE, full)) {
		const height = Math.min(full, room);
		return aboveRoomier
			? { left, top: anchor.top - gap - height, height, placement: 'above' }
			: { left, top: anchor.bottom + gap, height, placement: 'below' };
	}
	// The object fills the canvas: sit over it, clamped inside.
	return { left, top: clamp(anchor.top, margin, bounds.height - margin - full), height: full, placement: 'over' };
}

// --- Highlight shell geometry ---------------------------------------------------------------------

/**
 * Smoothed normals for the glow shell: vertices at the same position (the corners of a box have one per face) share
 * the average of their normals, so extruding along them keeps the outline closed instead of opening notches.
 * `positions` and `normals` are flat xyz arrays of equal length; the result has the same layout, unit length.
 */
export function smoothNormals(positions: ArrayLike<number>, normals: ArrayLike<number>): Float32Array {
	const count = Math.floor(positions.length / 3);
	const sums = new Map<string, [number, number, number]>();
	const keys: string[] = new Array(count);
	const q = (n: number) => Math.round(n * 1e4);
	for (let i = 0; i < count; i++) {
		const key = `${q(positions[i * 3])},${q(positions[i * 3 + 1])},${q(positions[i * 3 + 2])}`;
		keys[i] = key;
		let sum = sums.get(key);
		if (!sum) sums.set(key, (sum = [0, 0, 0]));
		sum[0] += normals[i * 3];
		sum[1] += normals[i * 3 + 1];
		sum[2] += normals[i * 3 + 2];
	}
	const out = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		const [x, y, z] = sums.get(keys[i]) as [number, number, number];
		const length = Math.hypot(x, y, z) || 1;
		out[i * 3] = x / length;
		out[i * 3 + 1] = y / length;
		out[i * 3 + 2] = z / length;
	}
	return out;
}
