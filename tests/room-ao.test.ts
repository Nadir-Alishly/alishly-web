// Source checks for the screen-space ambient occlusion overlay (src/scripts/room-ao.ts) and its wiring in room-core.ts,
// room-interact.ts, the admin editor and the import preview. The overlay needs WebGL, so Node only reads the source.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSeeThrough } from '../src/scripts/room-ao.ts';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ao = src('src/scripts/room-ao.ts');
const core = src('src/scripts/room-core.ts');

test('room-ao: exports createAoOverlay and is an overlay on the canvas (multiply, alpha kept, no depth test)', () => {
	assert.match(ao, /export function createAoOverlay\(/);
	assert.match(ao, /blendSrc: DstColorFactor/, 'colour = ao x canvas colour');
	assert.match(ao, /blendSrcAlpha: ZeroFactor/, 'alpha is not changed by the overlay');
	assert.match(ao, /blendDstAlpha: OneFactor/);
	assert.match(ao, /depthTest: false/);
	assert.match(ao, /pass\.output = GTAOPass\.OUTPUT\.Off/, 'the GTAO pass writes nothing to the canvas itself');
});

test('room-ao: the helper meshes are hidden for the AO pass and restored in a finally (never left hidden)', () => {
	assert.match(ao, /object\.userData\.noAo === true/, 'hides exactly the objects flagged noAo');
	assert.match(ao, /try \{\s*pass\.render\([^)]*\);\s*\} finally \{\s*restoreNonOccluders\(\);\s*\}/, 'restore runs in a finally');
});

test('room-ao: dispose frees the targets, the quad, the blend material and the two GTAO materials GTAOPass does not free', () => {
	const dispose = ao.slice(ao.indexOf('\t\tdispose() {'));
	for (const needle of ['restoreNonOccluders()', 'quad.dispose()', 'material.dispose()', 'pass.dispose()', 'pass.gtaoMaterial.dispose()', 'pass.blendMaterial.dispose()']) {
		assert.ok(dispose.includes(needle), `dispose calls ${needle}`);
	}
	assert.match(ao, /if \(disposed\) return;\s*\n\s*disposed = true;/, 'dispose is safe to call twice');
});

test('room-core: the AO module is loaded ONLY with a dynamic import (lazy); the only static import is the type', () => {
	assert.match(core, /import\('\.\/room-ao'\)/, 'dynamic import of room-ao');
	const staticImports = core.match(/^import\s+(?!type\s)[^;]*from\s+'\.\/room-ao'/gm) ?? [];
	assert.equal(staticImports.length, 0, 'no static (value) import of room-ao in room-core');
	assert.match(core, /import type \{ AoOverlay \} from '\.\/room-ao';/, 'the type-only import is allowed (erased)');
});

test('room-core: AO is only loaded while intensity > 0 (syncAo), and intensity 0 never calls the overlay', () => {
	assert.match(core, /const aoWanted = \(\) => !disposed && !aoFailed && settings\.ao\.intensity > 0;/);
	assert.match(core, /if \(!aoWanted\(\)\) \{\s*ao\?\.dispose\(\);\s*ao = null;\s*return;\s*\}/, 'syncAo frees it when off');
	assert.match(core, /if \(ao && settings\.ao\.intensity > 0\) \{/, 'the frame only renders AO when on');
	assert.match(core, /ao\.render\(settings\.ao\.intensity, settings\.ao\.radius, sceneRev\)/, 'AO runs after the main render');
});

test('room-core: the overlay is rebuilt after a WebGL context restore, and released on dispose before the renderer', () => {
	const restore = core.slice(core.indexOf('const onContextRestored = () => {'), core.indexOf('canvas.addEventListener(\'webglcontextrestored\''));
	assert.match(restore, /ao\?\.dispose\(\);[\s\S]*ao = null;/, 'the old overlay is dropped on restore');
	assert.match(restore, /aoFailed = false;/, 'a failure does not stick across a context restore');
	const disposePath = core.slice(core.indexOf('controls.dispose();'));
	const aoDispose = disposePath.indexOf('ao?.dispose();');
	const rendererDispose = disposePath.indexOf('renderer.dispose();');
	assert.ok(aoDispose > 0 && rendererDispose > aoDispose, 'ao is disposed before renderer.dispose()');
});

test('room-core: the frame resizes the AO targets with the canvas (setSize) and the scene revision drives recomputation', () => {
	assert.match(core, /ao\?\.setSize\(canvas\.width, canvas\.height\);/);
	assert.match(core, /sceneRev\+\+;/, 'invalidate() bumps the scene revision');
});

test('helper meshes are flagged noAo (room-core: pane, halo, pool, drop shadow, blocker)', () => {
	assert.match(core, /for \(const helper of \[pane, halo, pool, dropShadow, blocker\]\) helper\.userData\.noAo = true;/);
});

test('highlight shells, the editor gizmo / selection box and the import ghost are flagged noAo', () => {
	assert.match(src('src/scripts/room-interact.ts'), /mesh\.userData\.noAo = true;/, 'hover highlight shells');
	const editor = src('src/scripts/admin/editor.ts');
	assert.match(editor, /gizmoHelper\.userData\.noAo = true;/, 'gizmo');
	assert.match(editor, /highlight\.userData\.noAo = true;/, 'selection highlight');
	assert.match(src('src/scripts/admin/import-preview.ts'), /holder\.userData\.noAo = true;/, 'import ghost');
});

// ---------------------------------------------------------------------------------------------------------------
// round 2: see-through meshes do not occlude (foliage cards, glass, the blended lamp shade), the restore in the finally,
// the setSettings revision, and the coarse-pointer pass-through
// ---------------------------------------------------------------------------------------------------------------

test('isSeeThrough: transparent, alpha-tested and transmissive materials are see-through; opaque ones are not', () => {
	assert.equal(isSeeThrough({ transparent: true, alphaTest: 0 } as never), true, 'blended (glTF BLEND, the plant leaves, the lamp shade)');
	assert.equal(isSeeThrough({ transparent: false, alphaTest: 0.5 } as never), true, 'alpha-tested cards (glTF MASK)');
	assert.equal(isSeeThrough({ transparent: false, alphaTest: 0, transmission: 0.4 } as never), true, 'transmissive glass');
	assert.equal(isSeeThrough({ transparent: false, alphaTest: 0, transmission: 0 } as never), false, 'opaque standard');
	assert.equal(isSeeThrough({ transparent: false, alphaTest: 0 } as never), false, 'opaque Lambert/Physical without transmission');
	assert.equal(isSeeThrough({ alphaTest: 0 } as never), false, 'a material with no transparency flags');
});

test('room-ao: a mesh is a non-occluder when it is flagged noAo OR all its materials are see-through (the foliage fix)', () => {
	assert.match(ao, /function isNonOccluder\(object: Object3D\): boolean \{\s*if \(object\.userData\.noAo === true\) return true;/);
	assert.match(ao, /return list\.length > 0 && list\.every\(isSeeThrough\);/, 'a mixed mesh (opaque pot + leaves) still occludes through its opaque materials');
});

test('room-ao: the restore of the overlay state is in a finally (a throwing pass cannot leave the room drawn wrong)', () => {
	const render = ao.slice(ao.indexOf('\t\trender(intensity, radius, rev) {'), ao.indexOf('\t\tdispose() {'));
	const finallyBlock = render.slice(render.lastIndexOf('} finally {'));
	assert.ok(finallyBlock.length > 0, 'render has an outer finally');
	for (const needle of ['scene.overrideMaterial = null', 'renderer.setClearColor(clearColor, clearAlpha)', 'renderer.autoClear = autoClear', 'renderer.setRenderTarget(previousTarget)']) {
		assert.ok(finallyBlock.includes(needle), `the finally restores: ${needle}`);
	}
	assert.ok(render.indexOf('renderer.getClearColor(clearColor)') > 0 && render.indexOf('renderer.getClearColor(clearColor)') < render.indexOf('renderer.setClearColor(clearColor, clearAlpha)'), 'the clear colour is captured before the pass (and restored in the finally)');
});

test('room-ao: the normal pass is double-sided, so thin meshes seen from behind are not culled out of the AO buffer', () => {
	assert.match(ao, /pass\.normalMaterial\.side = DoubleSide;/);
});

test('room-ao: the lowQuality flag selects quarter resolution and 8 samples (coarse pointers), and is the default-off path', () => {
	assert.match(ao, /lowQuality = false,/);
	assert.match(ao, /const divisor = lowQuality \? 4 : 2;/);
	assert.match(ao, /samples: lowQuality \? 8 : 16/);
});

test('room-core: the coarse-pointer flag is passed to the overlay (touch devices get the cheaper AO)', () => {
	assert.match(core, /createAoOverlay\(renderer, scene, camera, canvas\.width, canvas\.height, coarsePointer\)/);
	assert.match(core, /const coarsePointer = window\.matchMedia\('\(pointer: coarse\)'\)\.matches;/);
});

test('room-core: a settings change keeps the scene revision (a slider drag re-runs only the cheap multiply, not the GTAO)', () => {
	const setSettings = core.slice(core.indexOf('\t\tsetSettings('), core.indexOf('\t\tsetRoom(config) {'));
	assert.match(setSettings, /const rev = sceneRev;/, 'the revision is read before invalidate()');
	assert.match(setSettings, /invalidate\(\);\s*\n[\s\S]*?sceneRev = rev;/, 'and restored after invalidate()');
});

test('room-objects: the missing-model placeholder (a wire outline) is flagged noAo inside buildMissingModel', () => {
	const objects = src('src/scripts/room-objects.ts');
	const start = objects.indexOf('function buildMissingModel(): Group {');
	assert.ok(start > 0, 'buildMissingModel found');
	const body = objects.slice(start, objects.indexOf('\n}\n', start));
	assert.match(body, /const group = new Group\(\);\s*\n\s*group\.userData\.noAo = true;/, 'the placeholder group is flagged before anything is added to it');
	assert.match(body, /new Mesh\(new BoxGeometry\(0\.6, 0\.6, 0\.6\), material\)/, 'the flagged group still holds the wire box');
});
