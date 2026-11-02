// Unit tests for src/data/hover-pick.ts (when the public room may re-pick the object under the mouse). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPickHover, pointerPickOwner, type HoverPickState } from '../src/data/hover-pick.ts';

const READY: HoverPickState = { disposed: false, inside: true, mouse: true, dragging: false };

test('canPickHover: a pointer over the canvas with a mouse and no drag may pick', () => {
	assert.equal(canPickHover(READY), true);
});

test('canPickHover: no pick once the layer is disposed, the pointer left, the pointer is a touch/pen, or a drag is on', () => {
	assert.equal(canPickHover({ ...READY, disposed: true }), false, 'disposed');
	assert.equal(canPickHover({ ...READY, inside: false }), false, 'pointer left the canvas');
	assert.equal(canPickHover({ ...READY, mouse: false }), false, 'touch or pen: no hover');
	assert.equal(canPickHover({ ...READY, dragging: true }), false, 'dragging the camera: no hover until release');
});

test('canPickHover: every field matters on its own (sweep over all 16 combinations; only the ready one passes)', () => {
	const bools = [false, true];
	let passes = 0;
	for (const disposed of bools) for (const inside of bools) for (const mouse of bools) for (const dragging of bools) {
		const ok = canPickHover({ disposed, inside, mouse, dragging });
		if (ok) passes++;
		assert.equal(ok, !disposed && inside && mouse && !dragging, JSON.stringify({ disposed, inside, mouse, dragging }));
	}
	assert.equal(passes, 1);
});

test('pointerPickOwner: while the camera moved in this or the previous frame, the frame hook picks (never the pointer)', () => {
	assert.equal(pointerPickOwner(true, false), 'frame', 'moved this frame');
	assert.equal(pointerPickOwner(false, true), 'frame', 'moved last frame (the view may still be settling)');
	assert.equal(pointerPickOwner(true, true), 'frame');
});

test('pointerPickOwner: with the camera still for two frames, the pointer picks on its own animation frame', () => {
	assert.equal(pointerPickOwner(false, false), 'pointer');
});
