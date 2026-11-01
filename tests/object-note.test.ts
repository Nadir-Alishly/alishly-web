// Unit tests for src/data/object-note.ts (pure logic of the public room's object notes). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	hasNote, collectNotes, noteButtonLabel, highlightedId, isClick, isNarrow, SHEET_BREAKPOINT,
	easeOutCubic, advanceProgress, placePopup, smoothNormals,
} from '../src/data/object-note.ts';
import type { PlaceInput } from '../src/data/object-note.ts';

// ---------- which objects are interactive ----------

test('hasNote: only a non-blank string paragraph counts; a title alone does nothing', () => {
	assert.equal(hasNote({ paragraph: 'Hi' }), true);
	assert.equal(hasNote({ paragraph: '  x  ' }), true);
	assert.equal(hasNote({}), false);
	assert.equal(hasNote({ paragraph: '' }), false);
	assert.equal(hasNote({ paragraph: ' \n\t ' }), false);
	assert.equal(hasNote({ paragraph: 5 }), false);
	assert.equal(hasNote({ paragraph: null }), false);
	assert.equal(hasNote({ title: 'T' } as never), false);
});

test('collectNotes: scene order, labels from title else catalog else raw type, title-only objects skipped', () => {
	const labels: Record<string, string> = { chair: 'Chair', 'model:p': 'Plant' };
	const out = collectNotes([
		{ id: 'a', type: 'chair', title: 'The chair', paragraph: 'p1' },
		{ id: 'b', type: 'box', paragraph: 'p2' },
		{ id: 'c', type: 'rug', title: 'title only' },
		{ id: 'd', type: 'chair', paragraph: 'p3' },
		{ id: 'e', type: 'model:p', title: '   ', paragraph: 'p4' },
		{ id: 'f', type: 'mystery', paragraph: 'p5' },
	], (t) => labels[t]);
	assert.deepEqual(out.map((n) => n.id), ['a', 'b', 'd', 'e', 'f']);
	assert.deepEqual(out.map((n) => n.title), ['The chair', null, null, null, null]);
	assert.deepEqual(out.map((n) => n.label), ['The chair', 'box', 'Chair', 'Plant', 'mystery']);
	assert.equal(noteButtonLabel(out[0]), 'The chair — read note');
	assert.equal(noteButtonLabel(out[2]), 'Chair — read note');
});

test('collectNotes: empty input / no notes -> empty list', () => {
	assert.deepEqual(collectNotes([], () => undefined), []);
	assert.deepEqual(collectNotes([{ id: 'a', type: 'box' }], () => 'Box'), []);
});

// ---------- highlight rule: hover vs selected ----------

test('highlightedId: hover takes over; leaving the hover returns to the selected object; never two', () => {
	assert.equal(highlightedId(null, null), null);
	assert.equal(highlightedId('A', null), 'A', 'hover alone');
	assert.equal(highlightedId(null, 'A'), 'A', 'selected alone');
	assert.equal(highlightedId('B', 'A'), 'B', 'takeover: hover B while A is selected');
	assert.equal(highlightedId(null, 'A'), 'A', 'mouse-leave returns to A');
	assert.equal(highlightedId('A', 'A'), 'A', 'hovering the selected object');
	// the result is always a single id (or null): exhaustive over a small id set
	for (const h of [null, 'A', 'B']) for (const s of [null, 'A', 'B']) {
		const r = highlightedId(h, s);
		assert.ok(r === null || r === h || r === s);
		assert.equal(r === null, h === null && s === null);
	}
});

test('highlightedId: a full hover/click sequence', () => {
	let hover: string | null = null; let selected: string | null = null;
	const seq: [string, string | null][] = [];
	const step = (label: string) => seq.push([label, highlightedId(hover, selected)]);
	hover = 'A'; step('hover A');
	selected = 'A'; step('click A');
	hover = 'B'; step('hover B (takeover)');
	hover = null; step('leave B');
	hover = 'B'; selected = 'B'; step('click B');
	hover = null; step('leave');
	selected = null; step('close');
	assert.deepEqual(seq.map((s) => s[1]), ['A', 'A', 'B', 'A', 'B', 'B', null]);
});

// ---------- click vs drag ----------

test('isClick: movement under the slop is a click, at or over it is a drag', () => {
	const d = { x: 100, y: 100 };
	assert.equal(isClick(d, { x: 100, y: 100 }, 5), true);
	assert.equal(isClick(d, { x: 103, y: 103 }, 5), true); // 4.24
	assert.equal(isClick(d, { x: 104, y: 103 }, 5), false); // exactly 5
	assert.equal(isClick(d, { x: 100, y: 95 }, 5), false);
	assert.equal(isClick(d, { x: 60, y: 100 }, 5), false);
	assert.equal(isClick(d, { x: 100, y: 96 }, 5), true);
});

// ---------- phone breakpoint ----------

test('isNarrow: bottom sheet below 640 px only', () => {
	assert.equal(SHEET_BREAKPOINT, 640);
	assert.equal(isNarrow(390), true);
	assert.equal(isNarrow(639), true);
	assert.equal(isNarrow(640), false);
	assert.equal(isNarrow(1280), false);
});

// ---------- float easing ----------

test('easeOutCubic: 0 -> 0, 1 -> 1, monotonic, clamped', () => {
	assert.equal(easeOutCubic(0), 0);
	assert.equal(easeOutCubic(1), 1);
	assert.equal(easeOutCubic(-3), 0);
	assert.equal(easeOutCubic(9), 1);
	let prev = -1;
	for (let t = 0; t <= 1.0001; t += 0.05) { const v = easeOutCubic(t); assert.ok(v >= prev); prev = v; }
	assert.ok(easeOutCubic(0.5) > 0.5, 'eases out');
});

test('advanceProgress: moves at 1/duration per ms, stops at the target, reverses mid-way, jumps for duration 0', () => {
	assert.equal(advanceProgress(0, 1, 100, 200), 0.5);
	assert.equal(advanceProgress(0.5, 1, 100, 200), 1);
	assert.equal(advanceProgress(0.9, 1, 1000, 200), 1, 'no overshoot');
	assert.equal(advanceProgress(0.5, 0, 50, 200), 0.25, 'reverse');
	assert.equal(advanceProgress(0.1, 0, 1000, 200), 0, 'no undershoot');
	assert.equal(advanceProgress(1, 1, 16, 200), 1);
	assert.equal(advanceProgress(0, 0, 16, 200), 0);
	assert.equal(advanceProgress(0.3, 1, 16, 0), 1, 'reduced motion: jump');
	assert.equal(advanceProgress(0.7, 0, 16, 0), 0);
	assert.equal(advanceProgress(0.2, 1, -50, 200), 0.2, 'negative dt never goes backwards');
});

// ---------- popup placement: clamp / flip / scroll ----------

const base = (over: Partial<PlaceInput> & { anchor?: Partial<PlaceInput['anchor']>; size?: Partial<PlaceInput['size']> } = {}): PlaceInput => ({
	anchor: { x: 500, top: 400, bottom: 460, ...over.anchor },
	size: { width: 320, height: 200, ...over.size },
	bounds: over.bounds ?? { width: 1000, height: 800 },
	margin: over.margin ?? 8,
	gap: over.gap ?? 12,
});

test('placePopup: centred above the object when it fits', () => {
	const p = placePopup(base());
	assert.equal(p.placement, 'above');
	assert.equal(p.left, 500 - 160);
	assert.equal(p.height, 200);
	assert.equal(p.top, 400 - 12 - 200, 'bottom edge sits `gap` above the object top');
});

test('placePopup: horizontal clamp at the left and right canvas edges', () => {
	assert.equal(placePopup(base({ anchor: { x: 5 } })).left, 8);
	assert.equal(placePopup(base({ anchor: { x: -300 } })).left, 8, 'object off-screen left');
	assert.equal(placePopup(base({ anchor: { x: 995 } })).left, 1000 - 8 - 320);
	assert.equal(placePopup(base({ anchor: { x: 5000 } })).left, 1000 - 8 - 320, 'object off-screen right');
});

test('placePopup: popup wider than the canvas shrinks and stays inside', () => {
	const p = placePopup(base({ bounds: { width: 200, height: 800 } }));
	assert.equal(p.left, 8);
	assert.ok(p.left + Math.min(320, 200 - 16) <= 200 - 8 + 1e-9);
});

test('placePopup: flips below when there is no room above', () => {
	const p = placePopup(base({ anchor: { x: 500, top: 100, bottom: 160 } }));
	assert.equal(p.placement, 'below');
	assert.equal(p.top, 160 + 12);
	assert.equal(p.height, 200);
});

test('placePopup: exact fit above is still above (boundary), one px less flips', () => {
	// room above = top - gap - margin; full = 200 -> top = 220
	assert.equal(placePopup(base({ anchor: { top: 220, bottom: 300 } })).placement, 'above');
	assert.equal(placePopup(base({ anchor: { top: 219, bottom: 300 } })).placement, 'below');
});

test('placePopup: neither side fits the whole popup -> roomier side, shorter height (text scrolls), stays inside', () => {
	const input = base({ bounds: { width: 1000, height: 500 }, size: { height: 400 }, anchor: { x: 500, top: 150, bottom: 300 } });
	const p = placePopup(input);
	// above room 150-12-8=130, below room 500-8-312=180 -> below
	assert.equal(p.placement, 'below');
	assert.equal(p.top, 312);
	assert.equal(p.height, 180);
	assert.ok(p.height < 400);
	assert.ok(p.top >= 8 && p.top + p.height <= 500 - 8);
});

test('placePopup: very tall natural size is capped to the canvas (2500-char note)', () => {
	const p = placePopup(base({ size: { height: 5000 }, anchor: { top: 500, bottom: 560 } }));
	assert.ok(p.height <= 800 - 16);
	assert.ok(p.top >= 8 && p.top + p.height <= 800 - 8 + 1e-9, JSON.stringify(p));
	assert.notEqual(p.placement, 'over');
});

test('placePopup: object filling the canvas -> over, clamped inside', () => {
	const p = placePopup(base({ anchor: { x: 500, top: 10, bottom: 790 }, size: { height: 300 } }));
	assert.equal(p.placement, 'over');
	assert.ok(p.top >= 8 && p.top + p.height <= 792);
	assert.equal(p.height, 300);
});

test('placePopup: sweep - the popup is always inside the canvas margins and never NaN', () => {
	const bounds = { width: 640, height: 480 };
	for (const ax of [-100, 0, 10, 320, 630, 900]) for (const top of [-50, 0, 30, 200, 450, 470]) for (const h of [40, 150, 480, 2000]) {
		// (anchors that intersect the canvas; a box that is entirely off-screen is a separate, reported limitation)
		const p = placePopup({ anchor: { x: ax, top, bottom: top + 60 }, size: { width: 300, height: h }, bounds, margin: 8, gap: 12 });
		const tag = JSON.stringify({ ax, top, h, p });
		for (const v of [p.left, p.top, p.height]) assert.ok(Number.isFinite(v), tag);
		assert.ok(p.left >= 8 - 1e-9 && p.left + 300 <= 640 - 8 + 1e-9, tag);
		assert.ok(p.top >= 8 - 1e-9 && p.top + p.height <= 480 - 8 + 1e-9, tag);
		assert.ok(p.height <= Math.min(h, 480 - 16) + 1e-9, tag);
	}
});

test('placePopup: zero-sized / degenerate canvas does not throw or produce NaN', () => {
	const p = placePopup({ anchor: { x: 0, top: 0, bottom: 0 }, size: { width: 300, height: 100 }, bounds: { width: 0, height: 0 }, margin: 8, gap: 12 });
	for (const v of [p.left, p.top, p.height]) assert.ok(Number.isFinite(v));
});

// ---------- smoothed normals ----------

test('smoothNormals: coincident vertices share one unit normal (box corners stay closed); lone vertices keep theirs', () => {
	// two faces meeting at the origin: +x face normal and +y face normal
	const positions = [0, 0, 0, 0, 0, 0, 5, 5, 5];
	const normals = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	const out = smoothNormals(positions, normals);
	assert.equal(out.length, 9);
	const s = Math.SQRT1_2;
	assert.ok(Math.abs(out[0] - s) < 1e-6 && Math.abs(out[1] - s) < 1e-6 && out[2] === 0);
	assert.deepEqual([...out.slice(0, 3)], [...out.slice(3, 6)]);
	assert.deepEqual([...out.slice(6, 9)], [0, 0, 1]);
	for (let i = 0; i < 3; i++) assert.ok(Math.abs(Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]) - 1) < 1e-6);
});

test('smoothNormals: opposite normals at one point do not produce NaN', () => {
	const out = smoothNormals([1, 1, 1, 1, 1, 1], [0, 1, 0, 0, -1, 0]);
	for (const v of out) assert.ok(Number.isFinite(v));
});

// ---------- round 2: numbered duplicate labels in the keyboard list ----------

const labelsOf = (objs: Parameters<typeof collectNotes>[0], map: Record<string, string> = { chair: 'Chair', box: 'Box', lamp: 'Lamp' }) =>
	collectNotes(objs, (t) => map[t]).map((n) => n.label);

test('collectNotes r2: identical labels are numbered from 1 in scene order; unique ones stay plain', () => {
	assert.deepEqual(labelsOf([
		{ id: 'a', type: 'chair', paragraph: 'p' },
		{ id: 'b', type: 'box', paragraph: 'p' },
		{ id: 'c', type: 'chair', paragraph: 'p' },
		{ id: 'd', type: 'chair', paragraph: 'p' },
	]), ['Chair 1', 'Box', 'Chair 2', 'Chair 3']);
});

test('collectNotes r2: a single note of a type is not numbered even if the room has other chairs without notes', () => {
	assert.deepEqual(labelsOf([
		{ id: 'a', type: 'chair' },
		{ id: 'b', type: 'chair', paragraph: 'p' },
		{ id: 'c', type: 'chair', title: 'Reading chair' },
	]), ['Chair']);
});

test('collectNotes r2: the same title on different types is numbered too; a title equal to another type label as well', () => {
	assert.deepEqual(labelsOf([
		{ id: 'a', type: 'chair', title: 'Memory', paragraph: 'p' },
		{ id: 'b', type: 'lamp', title: 'Memory', paragraph: 'p' },
		{ id: 'c', type: 'box', title: 'Chair', paragraph: 'p' },
		{ id: 'd', type: 'chair', paragraph: 'p' },
	]), ['Memory 1', 'Memory 2', 'Chair 1', 'Chair 2']);
});

test('collectNotes r2: numbering keeps ids/paragraphs/titles and gives unique button names ("Chair 1 — read note")', () => {
	const out = collectNotes([
		{ id: 'a', type: 'chair', paragraph: 'one' },
		{ id: 'b', type: 'chair', paragraph: 'two' },
	], () => 'Chair');
	assert.deepEqual(out.map((n) => [n.id, n.paragraph, n.title]), [['a', 'one', null], ['b', 'two', null]]);
	const names = out.map(noteButtonLabel);
	assert.deepEqual(names, ['Chair 1 — read note', 'Chair 2 — read note']);
	assert.equal(new Set(names).size, names.length);
});

test('collectNotes r2: stable and not cumulative when called again on the same input', () => {
	const input = [{ id: 'a', type: 'chair', paragraph: 'p' }, { id: 'b', type: 'chair', paragraph: 'p' }];
	assert.deepEqual(labelsOf(input), labelsOf(input));
	assert.deepEqual(labelsOf(input), ['Chair 1', 'Chair 2']);
	assert.equal(input.length, 2);
});
