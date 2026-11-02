// Unit tests for the per-object environment light in src/data/scene.ts (SceneObject.envLight: parse, clamp, drop on
// primitives, sparse serialisation, canonical key order) and the committed scene.json. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScene, serializeScene, emptyScene, restoreKeyOrder, ENV_LIGHT_MAX, ENV_LIGHT_MIN, PRIMITIVE_TYPES } from '../src/data/scene.ts';
import type { SceneObject } from '../src/data/scene.ts';
import { family } from '../src/data/family.ts';

const SLUGS = family.map((m) => m.slug);
const MODELS = ['tall-house-plant', 'piano', 'desk-set'];
const opts = { slugs: SLUGS, modelIds: MODELS };
const obj = (type: string, extra: Record<string, unknown> = {}) => ({ id: `${type.replace(/[^a-z]/g, '')}-1`, type, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...extra });
const sceneWith = (objects: unknown[]) => {
	const s = emptyScene(SLUGS);
	s.rooms[SLUGS[0]].objects = objects as SceneObject[];
	return s;
};
const parseOne = (o: Record<string, unknown>) => parseScene(JSON.parse(JSON.stringify(sceneWith([o]))), opts);

test('envLight: the range is 0..3 (the same as the objects.envIntensity prefill)', () => {
	assert.equal(ENV_LIGHT_MIN, 0);
	assert.equal(ENV_LIGHT_MAX, 3);
});

test('envLight: a model keeps a valid value, rounded to 4 decimals and never -0; no warning', () => {
	const r = parseOne(obj('model:piano', { envLight: 1.23456789 }));
	assert.deepEqual(r.warnings, []);
	assert.equal(r.scene.rooms[SLUGS[0]].objects[0].envLight, 1.2346);
	const zero = parseOne(obj('model:piano', { envLight: 0 }));
	assert.equal(Object.is(zero.scene.rooms[SLUGS[0]].objects[0].envLight, 0), true, '0 is kept as +0');
	assert.deepEqual(zero.warnings, []);
});

test('envLight: out of range is clamped to 0..3 with one warning naming the field', () => {
	const hi = parseOne(obj('model:piano', { envLight: 9 }));
	assert.equal(hi.scene.rooms[SLUGS[0]].objects[0].envLight, 3);
	assert.equal(hi.warnings.length, 1, hi.warnings.join(' | '));
	assert.ok(/envLight/.test(hi.warnings[0]) && /clamped/.test(hi.warnings[0]), hi.warnings[0]);
	const lo = parseOne(obj('model:piano', { envLight: -2 }));
	assert.equal(lo.scene.rooms[SLUGS[0]].objects[0].envLight, 0);
	assert.equal(lo.warnings.length, 1);
});

test('envLight: a non-number is dropped with one warning; the object itself is kept', () => {
	for (const bad of ['1.2', null, true, NaN, { x: 1 }]) {
		const r = parseOne(obj('model:piano', { envLight: bad }));
		assert.equal('envLight' in r.scene.rooms[SLUGS[0]].objects[0], false, `${JSON.stringify(bad)} dropped`);
		assert.equal(r.scene.rooms[SLUGS[0]].objects.length, 1, 'object kept');
		assert.equal(r.warnings.length, 1, `${JSON.stringify(bad)}: one warning`);
	}
});

test('envLight: a primitive (not a model) drops the field with a note, the primitive is kept', () => {
	const primitive = PRIMITIVE_TYPES[0];
	const r = parseOne(obj(primitive, { envLight: 1 }));
	assert.equal('envLight' in r.scene.rooms[SLUGS[0]].objects[0], false);
	assert.equal(r.scene.rooms[SLUGS[0]].objects.length, 1);
	assert.equal(r.warnings.length, 1);
	assert.ok(/only applies to models/.test(r.warnings[0]), r.warnings[0]);
});

test('envLight: absent stays absent (no key, no warning) and serialises only when set (sparse)', () => {
	const plain = parseOne(obj('model:piano'));
	assert.deepEqual(plain.warnings, []);
	assert.equal('envLight' in plain.scene.rooms[SLUGS[0]].objects[0], false, 'absent field is not added');
	assert.equal(serializeScene(plain.scene).includes('envLight'), false, 'no envLight key written for an untouched object');
	const set = parseOne(obj('model:piano', { envLight: 1.2 }));
	assert.ok(serializeScene(set.scene).includes('"envLight": 1.2'), 'a set value is written');
});

test('envLight: round-trips through serialise -> parse exactly at both range ends', () => {
	for (const v of [0, 1.2, 3]) {
		const r = parseOne(obj('model:piano', { envLight: v }));
		const back = parseScene(JSON.parse(serializeScene(r.scene)), opts);
		assert.deepEqual(back.warnings, []);
		assert.equal(back.scene.rooms[SLUGS[0]].objects[0].envLight, v, `round trip ${v}`);
	}
});

test('envLight: key order is color, title, paragraph, envLight (canonical, like the other optional fields)', () => {
	const o = obj('model:piano', { envLight: 1, paragraph: 'p', title: 't', color: '#ffffff' }) as unknown as SceneObject;
	restoreKeyOrder(o);
	assert.deepEqual(Object.keys(o).filter((k) => ['color', 'title', 'paragraph', 'envLight'].includes(k)), ['color', 'title', 'paragraph', 'envLight']);
});

test('committed src/data/scene.json still parses with no warnings and has no envLight anywhere', () => {
	const text = readFileSync(new URL('../src/data/scene.json', import.meta.url), 'utf8');
	const modelIds = (JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8')) as { id: string }[]).map((m) => m.id);
	const r = parseScene(JSON.parse(text), { slugs: SLUGS, modelIds });
	assert.deepEqual(r.warnings, [], r.warnings.join(' | '));
	assert.equal(text.includes('envLight'), false, 'the committed file has no per-object envLight (off for all by default)');
});
