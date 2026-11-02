// Source checks for the hover changes (the wiring lives in Vite-bundled scripts, so Node cannot import it): the hover
// float is gone, and the public room picks through the pure helpers in src/data/hover-pick.ts. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const interact = src('src/scripts/room-interact.ts');
const objects = src('src/scripts/room-objects.ts');
const note = src('src/data/object-note.ts');

test('hover float: no lift constants, lift setter, lift map or easing helpers remain in the public room code', () => {
	const gone = [/\bFLOAT_HEIGHT\b/, /\bFLOAT_MS\b/, /\bsetLift\b/, /\blifts\b/, /\beaseOutCubic\b/, /\badvanceProgress\b/];
	for (const [name, text] of [['room-interact.ts', interact], ['room-objects.ts', objects], ['object-note.ts', note]] as const) {
		for (const re of gone) assert.ok(!re.test(text), `${name} still has ${re}`);
	}
});

test('hover float: room-objects.ts no longer exports a lift setter, and nothing imports the removed easing helpers', () => {
	assert.ok(!/export\s+function\s+setLift/.test(objects), 'setLift is not exported');
	for (const [name, text] of [['room-interact.ts', interact], ['room-objects.ts', objects]] as const) {
		assert.ok(!/from\s+['"][^'"]*object-note[^'"]*['"]/.test(text) || !/easeOutCubic|advanceProgress/.test(text), `${name} does not use the removed helpers`);
	}
});

test('hover: the hover path does not re-render the shadow maps (room-interact.ts never calls invalidate)', () => {
	assert.ok(!/\binvalidate\s*\(/.test(interact), 'room-interact.ts has no invalidate() call');
});

test('hover: room-interact.ts picks through the pure helpers (canPickHover, pointerPickOwner)', () => {
	assert.match(interact, /from\s+['"]\.\.\/data\/hover-pick(\.ts)?['"]/, 'imports hover-pick');
	assert.match(interact, /\bcanPickHover\s*\(/, 'uses canPickHover before picking');
	assert.match(interact, /\bpointerPickOwner\s*\(/, 'uses pointerPickOwner to hand the pick to the frame hook');
});

test('hover: the 140 ms settle debounce is gone (the highlight is not cleared on every camera change)', () => {
	assert.ok(!/\bSETTLE_MS\b/.test(interact), 'no SETTLE_MS');
	assert.ok(!/\bsettleTimer\b/.test(interact), 'no settleTimer');
});

test('hover recovery (r2 M1): the drag flag is the mouse-button state alone, so a lost pointerup cannot leave hover off', () => {
	assert.match(interact, /dragging:\s*mouseButtons\s*!==\s*0/, 'dragging comes from mouseButtons');
	assert.ok(!/dragging:\s*active\b/.test(interact), 'the active pointer set does not gate hover');
	assert.match(interact, /mouseButtons\s*=\s*event\.buttons/, 'mouseButtons is refreshed from the event');
});

test('hover recovery (r2 M1): a pointermove with no buttons drops that pointer from the press set (a lost pointerup is not a second finger)', () => {
	assert.match(interact, /event\.buttons\s*===\s*0\s*&&\s*active\.delete\(event\.pointerId\)/, 'active is cleared on a button-up move');
	assert.match(interact, /press\?\.id\s*===\s*event\.pointerId\)\s*press\s*=\s*null/, 'the stale press is dropped with it');
});

test('camera motion (r2 M4): the frame hook stamps the last frame with a camera change; no sticky "moved last frame" flag remains', () => {
	assert.match(interact, /const moved\s*=\s*cameraMoved\s*\|\|\s*movedByCore;/, 'moved = the controls moved it or the core eased it (r3)');
	assert.match(interact, /if\s*\(moved\)\s*lastMoveAt\s*=\s*now/, 'lastMoveAt set from the frame hook');
	assert.match(interact, /const movedRecently\s*=\s*performance\.now\(\)\s*-\s*lastMoveAt\s*<\s*RECENT_MOVE_MS/, 'pointer picks only when the move is recent');
	assert.ok(!/cameraMovedLastFrame/.test(interact), 'cameraMovedLastFrame is gone');
});

// --- r3: the room-switch home ease and the late-loading models must re-pick the hover (the fix is in two files) ---
const core = src('src/scripts/room-core.ts');

test('room switch (r3): the core reports the home ease to the frame hook, so the hover re-picks during and after the ease', () => {
	assert.match(core, /let cameraEased = false;/, 'a per-frame flag for the ease');
	assert.match(core, /cameraTween[\s\S]*?cameraEased = true;/, 'the ease block sets the flag (including the final frame)');
	assert.match(core, /frameHook\(now, moved \|\| cameraEased\)/, 'the hook receives controls-moved or ease-moved');
	assert.match(core, /setFrameHook\(hook: \(\(now: number, cameraMoved: boolean\) => boolean\) \| null\): void;/, 'the hook type carries the flag');
});

test('room switch (r3): room-interact takes the core flag in onFrame, so an ease without a controls change still picks', () => {
	assert.match(interact, /function onFrame\(now: number, movedByCore: boolean\): boolean \{/, 'onFrame(now, movedByCore)');
	assert.match(interact, /const pickNow = moved \|\| deferredPick;/, 'a moved frame (or a deferred pick) picks');
	assert.match(interact, /if \(pickNow && canPickHover\(pickState\(\)\)\) \{/, 'the pick is still guarded by canPickHover');
});

test('room switch (r3): requestPick() asks for one pick through the core frame, not its own rAF loop', () => {
	const m = interact.match(/function requestPick\(\) \{([\s\S]*?)\n\t\}/);
	assert.ok(m, 'requestPick exists');
	assert.match(m[1], /if \(!canPickHover\(pickState\(\)\)\) return;/, 'only when hover can pick now');
	assert.match(m[1], /deferredPick = true;/, 'the next frame picks');
	assert.match(m[1], /core\.requestFrame\(\);/, 'through the core frame');
	assert.ok(!/requestAnimationFrame/.test(m[1]), 'no rAF of its own (no loop)');
});

test('room switch (r3): setObjects (the room swap) and a late model load both request one pick', () => {
	const so = interact.match(/setObjects\(objects\) \{([\s\S]*?)\n\t\t\},/);
	assert.ok(so, 'setObjects exists');
	assert.match(so[1], /clear\(\);/, 'the swap still clears first');
	assert.match(so[1], /requestPick\(\);/, 'the resting pointer is picked on the new room');
	// the onLoad body itself (up to its closing brace at the same indent), not a later requestPick() elsewhere
	const onLoad = interact.match(/core\.objects\.onLoad = \(id\) => \{([\s\S]*?)\n\t\};/);
	assert.ok(onLoad, 'onLoad exists');
	assert.match(onLoad[1], /requestPick\(\);/, 'a model that arrives late is picked again');
});
