// Source checks for the admin ghost's r2 fixes (the admin code is Vite-bundled three.js, so Node cannot import it):
// the ghost follows the spot on every change that can move it (M2), and clear() repaints only when there was something
// to remove (N4). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const editor = src('src/scripts/admin/editor.ts');
const preview = src('src/scripts/admin/import-preview.ts');

test('ghost relocate (r2 M2): the editor emit relocates the ghost for edit, scene, room and mode changes', () => {
	assert.match(
		editor,
		/if\s*\(reason === 'edit' \|\| reason === 'scene' \|\| reason === 'room' \|\| reason === 'mode'\)\s*importPreview\.relocate\(\)/,
		'emit covers every reason that can move the free spot',
	);
	// relocate() is called from the one emit hook (setScene/setRoom no longer call it directly)
	assert.equal((editor.match(/importPreview\.relocate\(\)/g) ?? []).length, 1, 'one relocate call site in the editor');
});

test('ghost relocate (r2 M2): the editor passes the Bounds state to the preview (fitOn), so a Bounds toggle moves the ghost', () => {
	assert.match(editor, /fitOn:\s*\(\)\s*=>\s*bounds/, 'fitOn wired to the Bounds toggle');
	assert.match(preview, /fitOn\(\): boolean/, 'the option is declared');
	assert.match(preview, /placedAt\s*=\s*placementKey\(spot\)/, 'the build records the placement key (r3 N5)');
	assert.match(
		preview,
		/relocate\(\) \{\s*if \(template && placedAt !== placementKey\(options\.spot\(\)\)\) build\(\);/,
		'relocate rebuilds only when the placement key differs',
	);
});

test('ghost relocate (r2 M2): the preview never raises the editor edit event (the unsaved flag is not touched)', () => {
	assert.ok(!/options\.onChange/.test(preview), 'no onChange from the preview');
	assert.ok(!/\bemit\(/.test(preview), 'the preview does not call emit');
	assert.ok(!/'edit'/.test(preview), 'no edit reason in the preview');
});

test('ghost clear (r2 N4): clear() repaints only when a ghost or a template existed', () => {
	assert.match(preview, /const had = ghost !== null \|\| template !== null;/, 'had is computed before dropping');
	assert.match(preview, /if \(had\) options\.repaint\(\);/, 'repaint is guarded by had');
});

test('ghost placement key (r3 N5): one helper defines the key (spot + fit), so build and relocate cannot drift', () => {
	assert.match(preview, /const placementKey = \(spot: Vec3\) => `\$\{spot\.join\(','\)\}\|\$\{options\.fitOn\(\)\}`;/, 'placementKey is spot + fit');
	assert.equal((preview.match(/join\(','\)/g) ?? []).length, 1, 'the spot is joined in one place only');
	assert.equal((preview.match(/placementKey\(/g) ?? []).length, 2, 'the helper is called by build (placedAt) and relocate (the definition is an arrow assignment)');
});
