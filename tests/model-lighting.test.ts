// Unit tests for src/scripts/model-lighting.ts (per-object environment light: envMap + envMapIntensity on MeshStandard/
// Physical materials, and the model AO-map strength with the authored value restored), plus source checks for the wiring in
// room-objects.ts and room-core.ts (Node cannot import the three.js scripts). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyModelLighting, applyModelLightingTo, recordAuthoredAo } from '../src/scripts/model-lighting.ts';
import type { ModelLightingNode } from '../src/scripts/model-lighting.ts';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Duck-typed stand-ins: the helper only reads the isMesh* flags, userData and writes the light fields.
const standard = (aoMapIntensity = 1) => ({ isMeshStandardMaterial: true, envMap: null as unknown, envMapIntensity: 1, aoMapIntensity, needsUpdate: false, userData: {} as Record<string, unknown> });
const physical = () => ({ ...standard(), isMeshPhysicalMaterial: true });
const lambert = () => ({ isMeshLambertMaterial: true, envMap: null as unknown, envMapIntensity: 1, aoMapIntensity: 1, needsUpdate: false });
const env = () => ({ name: 'pmrem-texture', disposed: 0, dispose() { this.disposed++; } });

test('applyModelLighting: an opted-in MeshStandard gets the env map, its own strength, and AO = authored x aoIntensity', () => {
	const e = env();
	const m = standard(0.8);
	assert.equal(applyModelLighting(m, e, 1.7, 1), true, 'lightable');
	assert.equal(m.envMap, e);
	assert.equal(m.envMapIntensity, 1.7);
	assert.equal(m.aoMapIntensity, 0.8, 'aoIntensity 1 = as authored');
	assert.equal(m.needsUpdate, true, 'a new envMap needs a program rebuild');
	assert.equal(e.disposed, 0, 'the shared env texture is never disposed through a material');
});

test('applyModelLighting: a MeshPhysical material (a MeshStandard subclass) gets the same treatment', () => {
	const e = env();
	const m = physical();
	assert.equal(applyModelLighting(m, e, 2, 1), true);
	assert.equal(m.envMap, e);
	assert.equal(m.envMapIntensity, 2);
});

test('applyModelLighting: not opted in (envLight null) = no own envMap, so the scene environment applies as before', () => {
	const e = env();
	const m = standard(0.7);
	applyModelLighting(m, e, 1.5, 1); // was lit
	m.needsUpdate = false;
	m.envMapIntensity = 1.5;
	assert.equal(applyModelLighting(m, e, null, 1), true);
	assert.equal(m.envMap, null, 'envMap removed');
	assert.equal(m.needsUpdate, true, 'the program drops its envMap variant');
	assert.equal(m.envMapIntensity, 1.5, 'envMapIntensity is left alone when not opted in');
	assert.equal(m.aoMapIntensity, 0.7, 'the authored AO is still in force');
});

test('applyModelLighting: null -> null is a no-op for needsUpdate (no program rebuild each slider tick)', () => {
	const m = standard();
	applyModelLighting(m, env(), null, 1);
	m.needsUpdate = false;
	applyModelLighting(m, env(), null, 1);
	assert.equal(m.needsUpdate, false);
});

test('applyModelLighting: an opted-in model with no env yet (build failed / not built) has no envMap and asks for nothing', () => {
	const m = standard();
	applyModelLighting(m, null, 1.2, 1);
	assert.equal(m.envMap, null);
	assert.equal(m.envMapIntensity, 1.2, 'the strength is still recorded for when the environment arrives');
});

test('applyModelLighting: AO is authored x aoIntensity; the authored value is recorded once and restored exactly', () => {
	const m = standard(0.7);
	applyModelLighting(m, env(), null, 0.5);
	assert.equal(m.aoMapIntensity, 0.35, 'scaled by the global AO slider');
	assert.equal(m.userData.authoredAoIntensity, 0.7, 'the file value is remembered');
	applyModelLighting(m, env(), 1, 0.5);
	assert.equal(m.aoMapIntensity, 0.35, 'a second call does not multiply the scaled value again');
	applyModelLighting(m, env(), 1, 1);
	assert.equal(m.aoMapIntensity, 0.7, 'aoIntensity 1 restores the authored value exactly');
	applyModelLighting(m, env(), 1, 0);
	assert.equal(m.aoMapIntensity, 0, 'aoIntensity 0 switches the model AO off');
});

test('recordAuthoredAo: stores the file value once, on a fresh clone, and ignores non-Standard materials', () => {
	const m = standard(0.6);
	recordAuthoredAo(m);
	m.aoMapIntensity = 0.1; // someone lowered it
	recordAuthoredAo(m);
	assert.equal(m.userData.authoredAoIntensity, 0.6, 'the first (authored) value wins');
	const l = lambert();
	recordAuthoredAo(l);
	assert.equal('userData' in l, false, 'Lambert gets nothing written');
});

test('applyModelLighting: Lambert and other non-Standard materials are left exactly as they were', () => {
	const e = env();
	const m = lambert();
	const before = { ...m };
	assert.equal(applyModelLighting(m, e, 2, 0.5), false, 'not lightable');
	assert.deepEqual(m, before, 'no field written');
	const plain = { color: 'red' };
	assert.equal(applyModelLighting(plain, e, 2, 0.5), false);
	assert.deepEqual(plain, { color: 'red' });
});

test('applyModelLighting: a second call with the same env does not ask for a rebuild, but applies the new strength', () => {
	const e = env();
	const m = standard();
	applyModelLighting(m, e, 1.2, 1);
	m.needsUpdate = false; // as if the renderer had rebuilt the program
	applyModelLighting(m, e, 2.5, 1);
	assert.equal(m.needsUpdate, false, 'same env identity: no rebuild');
	assert.equal(m.envMapIntensity, 2.5, 'live slider value applied');
});

test('applyModelLightingTo: walks material arrays and children; Lambert of the same model is untouched', () => {
	const e = env();
	const a = standard(), b = physical(), c = lambert(), d = standard();
	const root: ModelLightingNode = {
		material: null,
		children: [{ material: [a, c] }, { material: b, children: [{ material: d }] }, { material: undefined }],
	};
	applyModelLightingTo(root, e, 1.4, 1);
	for (const m of [a, b, d]) {
		assert.equal(m.envMap, e);
		assert.equal(m.envMapIntensity, 1.4);
	}
	assert.equal(c.envMap, null, 'Lambert untouched');
	assert.equal(c.envMapIntensity, 1);
});

test('applyModelLightingTo: a node without materials or children is fine', () => {
	assert.doesNotThrow(() => applyModelLightingTo({}, env(), 1, 1));
	assert.doesNotThrow(() => applyModelLightingTo({ children: [] }, null, null, 1));
});

// ---------------------------------------------------------------------------------------------------------------
// wiring (source checks: each model is lit on its own, on load, on update and on settings changes; AO is released on dispose)
// ---------------------------------------------------------------------------------------------------------------

test('room-objects: the object manager defines setModelLighting, lightModel and unlightModel', () => {
	const objects = src('src/scripts/room-objects.ts');
	const manager = objects.slice(objects.indexOf('export function createObjectManager'));
	for (const name of ['setModelLighting', 'lightModel', 'unlightModel']) {
		assert.match(manager, new RegExp(`\\n\\t\\t${name}\\s*\\(`), `${name} is a method of the object returned by createObjectManager`);
	}
});

test('room-objects: a model that loads late is lit per holder in the loader callback, right after it is added', () => {
	const objects = src('src/scripts/room-objects.ts');
	assert.match(objects, /holder\.add\(instantiateModel\([^)]*\)\);\s*lightHolder\(holder\)/, 'lightHolder(holder) directly follows holder.add(instantiateModel(...))');
});

test('room-objects: update(object) stores the holder envLight and re-lights it in both directions (on and off)', () => {
	const objects = src('src/scripts/room-objects.ts');
	const update = objects.slice(objects.indexOf('\t\tupdate(object) {'), objects.indexOf('\t\tremove,', objects.indexOf('\t\tupdate(object) {')));
	assert.match(update, /holder\.userData\.envLight = object\.envLight;\s*\n\s*lightHolder\(holder\)/, 'the stored envLight is applied right away');
});

test('room-objects: a per-holder light comes from the holder (not the settings) on every settings change', () => {
	const objects = src('src/scripts/room-objects.ts');
	assert.match(objects, /const lightHolder = \(holder: Object3D\) => lightUp\(holder, \(holder\.userData\.envLight as number \| undefined\) \?\? null\)/);
	assert.match(objects, /setModelLighting\(env, settings\) \{[\s\S]*?for \(const holder of holders\.values\(\)\) lightHolder\(holder\);/, 'setModelLighting re-lights every holder');
});

test('room-core: dispose hands the models null before objects.dispose() and before the environment is freed', () => {
	const core = src('src/scripts/room-core.ts');
	const clear = core.indexOf('objects.setModelLighting(null, settings.objects)');
	assert.ok(clear > 0, 'dispose calls objects.setModelLighting(null, settings.objects)');
	assert.ok(clear > core.indexOf('controls.dispose();'), 'the call sits in the dispose path (after controls.dispose())');
	const objectsDispose = core.indexOf('objects.dispose();', clear);
	const envDispose = core.lastIndexOf('environment?.dispose();');
	assert.ok(objectsDispose > clear, 'setModelLighting(null) comes before objects.dispose()');
	assert.ok(envDispose > clear, 'setModelLighting(null) comes before environment?.dispose() in dispose');
});

test('room-core: buildEnvironment ends by handing the new texture (or null after a failed build) to the models', () => {
	const core = src('src/scripts/room-core.ts');
	const start = core.indexOf('const buildEnvironment = () => {');
	const end = core.indexOf('\n\tbuildEnvironment();', start);
	assert.ok(start > 0 && end > start, 'buildEnvironment found, then called once');
	const body = core.slice(start, end);
	assert.match(body, /objects\.setModelLighting\(environment\?\.texture \?\? null, settings\.objects\);\s*\};\s*$/, 'the last statement of buildEnvironment is the setModelLighting call');
});
