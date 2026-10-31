// Unit tests for src/data/scene.ts. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseScene, validateScene, serializeScene, emptyScene, cloneScene, snapTo, roundTo, shiftIntoRange,
	parseModels, isPrimitiveType, modelIdOf, PRIMITIVE_TYPES, LIMITS, ROOM_BOUNDS,
} from '../src/data/scene.ts';

const SLUGS = ['elnur', 'sabina', 'nadir', 'chinara', 'alibala', 'elkhan', 'fazil'];
const MODELS = ['crate'];
const opts = { slugs: SLUGS, modelIds: MODELS };

const obj = (over: Record<string, unknown> = {}) => ({
	id: 'bed-1', type: 'bed', position: [1, 0, 2], rotation: [0, 90, 0], scale: [1, 1, 1], color: '#AABBCC', ...over,
});
const scene = (rooms: Record<string, unknown>, version: unknown = 1) => ({ version, rooms });
const roomOf = (objects: unknown[]) => ({ objects });

test('valid scene: kept as is, lowercased colour, degrees untouched', () => {
	const r = parseScene(scene({ elnur: roomOf([obj()]) }), opts);
	assert.equal(r.ok, true);
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(r.scene.rooms.elnur.objects[0], {
		id: 'bed-1', type: 'bed', position: [1, 0, 2], rotation: [0, 90, 0], scale: [1, 1, 1], color: '#aabbcc',
	});
	assert.equal(r.scene.rooms.elnur.objects[0].rotation[1], 90, 'rotation stays in degrees, not converted to radians');
});

test('seeded shape: all 7 rooms empty is valid and round-trips', () => {
	const seed = emptyScene(SLUGS);
	const r = parseScene(seed, opts);
	assert.equal(r.ok, true);
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(Object.keys(r.scene.rooms), SLUGS);
	assert.deepEqual(r.scene, seed);
});

test('missing rooms are added empty, output follows slug order', () => {
	const r = parseScene(scene({ fazil: roomOf([]), elnur: roomOf([obj()]) }), opts);
	assert.deepEqual(Object.keys(r.scene.rooms), SLUGS);
	assert.equal(r.scene.rooms.sabina.objects.length, 0);
	assert.equal(r.scene.rooms.elnur.objects.length, 1);
});

test('color is optional', () => {
	const o = obj(); delete (o as Record<string, unknown>).color;
	const r = parseScene(scene({ elnur: roomOf([o]) }), opts);
	assert.deepEqual(r.warnings, []);
	assert.equal('color' in r.scene.rooms.elnur.objects[0], false);
});

test('every primitive type and model:<id> is accepted', () => {
	const objects = [...PRIMITIVE_TYPES.map((t, i) => obj({ id: `o${i}`, type: t })), obj({ id: 'm1', type: 'model:crate' })];
	const r = parseScene(scene({ elnur: roomOf(objects) }), opts);
	assert.deepEqual(r.warnings, []);
	assert.equal(r.scene.rooms.elnur.objects.length, PRIMITIVE_TYPES.length + 1);
	assert.equal(PRIMITIVE_TYPES.length, 8);
});

test('invalid objects are dropped with one warning each, valid siblings kept', () => {
	const bad = [
		obj({ id: 'a', type: 'sofa' }),                       // unknown type
		obj({ id: 'b', type: 'model:nope' }),                 // unknown model
		obj({ id: 'c', type: 5 }),                            // type wrong type
		obj({ id: '' }),                                      // empty id
		obj({ id: 'has space' }),                             // bad id chars
		obj({ id: 'x'.repeat(65) }),                          // id too long
		obj({ id: 42 }),                                      // id not a string
		obj({ id: 'd', position: [1, 2] }),                   // short vector
		obj({ id: 'e', position: [1, 2, 3, 4] }),             // long vector
		obj({ id: 'f', position: 'x' }),                      // not an array
		obj({ id: 'g', position: [1, '2', 3] }),              // string number
		obj({ id: 'h', position: [1, NaN, 3] }),              // NaN
		obj({ id: 'i', position: [Infinity, 0, 0] }),         // Infinity
		obj({ id: 'j', position: [LIMITS.maxPosition + 1, 0, 0] }),
		obj({ id: 'k', scale: [0, 1, 1] }),                   // zero scale
		obj({ id: 'l', scale: [-1, 1, 1] }),                  // negative scale
		obj({ id: 'm', scale: [LIMITS.maxScale + 1, 1, 1] }),
		obj({ id: 'n', rotation: [LIMITS.maxRotation + 1, 0, 0] }),
		obj({ id: 'o', color: 'red' }),                       // bad colour
		obj({ id: 'p', color: '#fff' }),                      // short hex
		obj({ id: 'q', color: 123 }),                         // colour not a string
		null, 7, 'str', [], undefined,
		{ id: 'r', type: 'bed' },                             // missing fields
	];
	const good = obj({ id: 'good' });
	const r = parseScene(scene({ elnur: roomOf([...bad, good]) }), opts);
	assert.equal(r.ok, true);
	assert.deepEqual(r.scene.rooms.elnur.objects.map((o) => o.id), ['good']);
	assert.equal(r.warnings.length, bad.length, r.warnings.join('\n'));
	assert.ok(r.warnings.every((w) => w.includes('elnur') && /dropped/.test(w)));
});

test('missing required fields are each rejected', () => {
	for (const key of ['id', 'type', 'position', 'rotation', 'scale']) {
		const o = obj() as Record<string, unknown>; delete o[key];
		const r = parseScene(scene({ elnur: roomOf([o]) }), opts);
		assert.equal(r.scene.rooms.elnur.objects.length, 0, `missing ${key} must drop the object`);
		assert.equal(r.warnings.length, 1, `missing ${key}`);
	}
});

test('duplicate ids inside a room are dropped; same id in another room is fine', () => {
	const r = parseScene(scene({
		elnur: roomOf([obj({ id: 'same' }), obj({ id: 'same', type: 'table' })]),
		sabina: roomOf([obj({ id: 'same' })]),
	}), opts);
	assert.equal(r.scene.rooms.elnur.objects.length, 1);
	assert.equal(r.scene.rooms.elnur.objects[0].type, 'bed', 'the first one wins');
	assert.equal(r.scene.rooms.sabina.objects.length, 1);
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /duplicate id/);
});

test('unknown slugs are dropped with a warning when slugs are given', () => {
	const r = parseScene(scene({ elnur: roomOf([]), stranger: roomOf([obj()]) }), opts);
	assert.equal('stranger' in r.scene.rooms, false);
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /stranger/);
	assert.equal(r.ok, true);
});

test('without slugs, well-formed slugs are kept and malformed ones dropped', () => {
	const r = parseScene(scene({ 'any-room': roomOf([obj()]), 'Bad Slug!': roomOf([]), '__proto__x': roomOf([]) }));
	assert.deepEqual(Object.keys(r.scene.rooms), ['any-room']);
	assert.equal(r.warnings.length, 2);
});

test('without modelIds, any well-formed model:<id> is accepted; malformed ones are not', () => {
	const r = parseScene(scene({ elnur: roomOf([obj({ id: 'a', type: 'model:whatever' }), obj({ id: 'b', type: 'model:' }), obj({ id: 'c', type: 'model:a b' })]) }), { slugs: SLUGS });
	assert.deepEqual(r.scene.rooms.elnur.objects.map((o) => o.id), ['a']);
});

test('room with a bad shape is treated as empty with a warning', () => {
	for (const room of [null, 5, 'x', [], {}, { objects: 'nope' }, { objects: {} }]) {
		const r = parseScene(scene({ elnur: room }), opts);
		assert.equal(r.ok, true);
		assert.deepEqual(r.scene.rooms.elnur.objects, [], JSON.stringify(room));
		assert.equal(r.warnings.length, 1, JSON.stringify(room));
	}
});

test('unusable input: not ok, never throws, scene is empty and usable', () => {
	for (const input of [null, undefined, 5, 'str', [], true, scene({}, 2), scene({}, '1'), { rooms: {} }, { version: 1 }, { version: 1, rooms: [] }, { version: 1, rooms: null }, { version: 1, rooms: 'x' }]) {
		const r = parseScene(input, opts);
		assert.equal(r.ok, false, JSON.stringify(input));
		assert.ok(r.warnings.length >= 1);
		assert.equal(r.scene.version, 1);
		assert.deepEqual(Object.keys(r.scene.rooms), SLUGS, 'with slugs the fallback has every room, empty');
		assert.ok(SLUGS.every((s) => r.scene.rooms[s].objects.length === 0));
	}
});

test('unknown keys are stripped and key order is canonical', () => {
	const r = parseScene(scene({ elnur: { objects: [{ ...obj(), evil: 'x', __proto__: { polluted: 1 } }], extra: 1 }, extraRoomKey: 1 }), opts);
	const o = r.scene.rooms.elnur.objects[0];
	assert.deepEqual(Object.keys(o), ['id', 'type', 'position', 'rotation', 'scale', 'color']);
	assert.equal(({} as Record<string, unknown>).polluted, undefined, 'no prototype pollution');
	assert.deepEqual(Object.keys(r.scene.rooms.elnur), ['objects']);
});

test('"__proto__" / "constructor" slugs cannot pollute or crash', () => {
	const raw = JSON.parse('{"version":1,"rooms":{"__proto__":{"objects":[]},"constructor":{"objects":[]},"elnur":{"objects":[]}}}');
	const r = parseScene(raw, opts);
	assert.equal(r.ok, true);
	assert.deepEqual(Object.keys(r.scene.rooms), SLUGS);
	assert.equal(({} as Record<string, unknown>).objects, undefined);
});

test('-0 is normalised to 0', () => {
	const r = parseScene(scene({ elnur: roomOf([obj({ position: [-0, -0, -0], rotation: [-0, 0, 0] })]) }), opts);
	const o = r.scene.rooms.elnur.objects[0];
	for (const n of [...o.position, ...o.rotation]) assert.ok(Object.is(n, 0), `got ${Object.is(n, -0) ? '-0' : n}`);
	assert.ok(!serializeScene(r.scene).includes('-0'));
});

test('limits: boundary values accepted, one past rejected; 500-object cap', () => {
	const edge = obj({ position: [LIMITS.maxPosition, -LIMITS.maxPosition, 0], rotation: [LIMITS.maxRotation, -LIMITS.maxRotation, 0], scale: [LIMITS.minScale, LIMITS.maxScale, 1] });
	assert.deepEqual(parseScene(scene({ elnur: roomOf([edge]) }), opts).warnings, []);
	const many = Array.from({ length: LIMITS.maxObjectsPerRoom + 3 }, (_, i) => obj({ id: `o${i}` }));
	const r = parseScene(scene({ elnur: roomOf(many) }), opts);
	assert.equal(r.scene.rooms.elnur.objects.length, LIMITS.maxObjectsPerRoom);
	assert.equal(r.warnings.length, 1);
});

test('validateScene: empty for valid, non-empty for anything dropped', () => {
	assert.deepEqual(validateScene(scene({ elnur: roomOf([obj()]) }), opts), []);
	assert.ok(validateScene(scene({ elnur: roomOf([obj({ type: 'nope' })]) }), opts).length > 0);
	assert.ok(validateScene({ version: 2, rooms: {} }, opts).length > 0);
	assert.ok(validateScene(scene({ stranger: roomOf([]) }), opts).length > 0);
});

test('serializeScene: 2-space indent, trailing newline, parses back to the same scene', () => {
	const r = parseScene(scene({ elnur: roomOf([obj()]) }), opts);
	const text = serializeScene(r.scene);
	assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'));
	assert.match(text, /^\{\n {2}"version": 1,\n/);
	// `settings` is stored sparse (only differences from the defaults), so the file text itself lacks the complete
	// settings object; the parsed file equals the scene. Sparse storage is covered in tests/scene-settings.test.ts.
	assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'rooms'], 'default settings are not written');
	assert.deepEqual(parseScene(JSON.parse(text), opts).scene, r.scene);
	assert.equal(serializeScene(parseScene(JSON.parse(text), opts).scene), text, 'stable under reparse');
});

test('cloneScene is deep', () => {
	const a = parseScene(scene({ elnur: roomOf([obj()]) }), opts).scene;
	const b = cloneScene(a);
	b.rooms.elnur.objects[0].position[0] = 99;
	assert.equal(a.rooms.elnur.objects[0].position[0], 1);
});

test('helpers: isPrimitiveType / modelIdOf', () => {
	assert.equal(isPrimitiveType('bed'), true);
	assert.equal(isPrimitiveType('model:crate'), false);
	assert.equal(isPrimitiveType('toString'), false);
	assert.equal(modelIdOf('model:crate'), 'crate');
	assert.equal(modelIdOf('bed'), null);
});

test('helpers: snapTo / roundTo / shiftIntoRange', () => {
	assert.equal(snapTo(0.37, 0.25), 0.25);
	assert.equal(snapTo(0.38, 0.25), 0.5);
	assert.equal(snapTo(-0.1, 0.25), 0);
	assert.ok(Object.is(snapTo(-0.01, 0.25), 0), 'no -0');
	assert.equal(snapTo(37, 15), 30);
	assert.equal(snapTo(1.04, 0.1), 1);
	assert.equal(roundTo(1.234567, 2), 1.23);
	assert.equal(shiftIntoRange(-4, -2, -3, 3), 1);
	assert.equal(shiftIntoRange(2, 4, -3, 3), -1);
	assert.equal(shiftIntoRange(-1, 1, -3, 3), 0);
	assert.equal(shiftIntoRange(-5, 5, -3, 3), 2, 'larger than range: low side wins');
	assert.deepEqual(ROOM_BOUNDS.min, [-3, 0, -3]);
	assert.deepEqual(ROOM_BOUNDS.max, [3.2, 3, 3.2]);
});

test('the committed scene.json and models.json are valid with the real slugs/models', async () => {
	const { readFileSync } = await import('node:fs');
	const raw = JSON.parse(readFileSync(new URL('../src/data/scene.json', import.meta.url), 'utf8'));
	const models = JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8'));
	const r = parseScene(raw, { slugs: SLUGS, modelIds: models.map((m: { id: string }) => m.id) });
	assert.equal(r.ok, true);
	assert.deepEqual(r.warnings, []);
});

// ---- fix round 2 ------------------------------------------------------------------------------

test('warnings name the object (type + id) when readable, so it can be found in the editor', () => {
	const r = parseScene(scene({ elnur: roomOf([obj(), obj({ id: 'tbl-9', type: 'table', scale: [0, 1, 1] })]) }), opts);
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /^room "elnur" object #1 \(table "tbl-9"\): scale out of range/);
	assert.match(r.warnings[0], /dropped$/);
});

test('warnings: no name when id/type are unreadable; long ids/types are cut to 40 chars', () => {
	const r = parseScene(scene({ elnur: roomOf([null, { id: 5, type: 'bed' }, obj({ id: 'x'.repeat(100), type: 'sofa'.repeat(30) })]) }), opts);
	assert.equal(r.warnings.length, 3);
	assert.ok(r.warnings[0].startsWith('room "elnur" object #0: not an object'));
	assert.ok(r.warnings[1].startsWith('room "elnur" object #1: id must be'));
	assert.ok(r.warnings[2].length < 250, `long names are truncated (${r.warnings[2].length})`);
	assert.ok(!r.warnings[2].includes('x'.repeat(41)));
});

test('warning for a duplicate id names the object and the id', () => {
	const r = parseScene(scene({ elnur: roomOf([obj({ id: 'a' }), obj({ id: 'a' })]) }), opts);
	assert.match(r.warnings[0], /object #1 \(bed "a"\): duplicate id "a", dropped/);
});

test('M1: a build that reads a broken scene.json falls back to empty rooms (the load-scene.ts logic, minus ?raw)', () => {
	const broken = ['{"version":1,"rooms":{},}', '', '{', '[{"id":', 'not json at all', '\u0000'];
	for (const text of broken) {
		let raw: unknown = null;
		try { raw = JSON.parse(text); } catch { /* load-scene.ts warns and keeps null */ }
		const r = parseScene(raw, opts);
		assert.deepEqual(Object.keys(r.scene.rooms), SLUGS, JSON.stringify(text));
		assert.ok(SLUGS.every((s) => r.scene.rooms[s].objects.length === 0));
		assert.equal(r.scene.version, 1);
	}
	// Valid JSON of the wrong shape must not throw either
	for (const raw of [null, 1, 'x', [], [1, 2], { version: 1, rooms: [] }, { version: 'one', rooms: {} }, { rooms: {} }]) {
		assert.doesNotThrow(() => parseScene(raw, opts));
		assert.deepEqual(Object.keys(parseScene(raw, opts).scene.rooms), SLUGS);
	}
});

test('M1: parseModels keeps usable entries and never throws', () => {
	const good = { id: 'crate', label: 'Crate', file: '/models/crate.glb', defaultScale: 1 };
	assert.deepEqual(parseModels([good]), [good]);
	assert.deepEqual(parseModels([good, { ...good, id: 'two', label: 'Two', defaultScale: 0.5 }]).map((m) => m.id), ['crate', 'two']);
	for (const input of [null, undefined, 5, 'x', {}, { id: 'a' }, [], [null], [1, 'x', []], '[{"id":']) {
		assert.deepEqual(parseModels(input), [], JSON.stringify(input));
	}
});

test('M1: parseModels drops each kind of bad entry, keeping the good ones', () => {
	const good = { id: 'ok', label: 'OK', file: '/models/ok.glb', defaultScale: 1 };
	const bad: unknown[] = [
		{ ...good, id: '' }, { ...good, id: 'has space' }, { ...good, id: 7 }, { ...good, id: 'x'.repeat(65) },
		{ ...good, id: 'b1', label: 5 }, { ...good, id: 'b2', file: 'models/relative.glb' }, { ...good, id: 'b3', file: 5 },
		{ ...good, id: 'b4', defaultScale: 0 }, { ...good, id: 'b5', defaultScale: -1 }, { ...good, id: 'b6', defaultScale: 51 },
		{ ...good, id: 'b7', defaultScale: NaN }, { ...good, id: 'b8', defaultScale: '1' }, { ...good, id: 'b9', defaultScale: Infinity },
		{ id: 'b10', label: 'x', file: '/a.glb' }, { id: 'b11', label: 'x', defaultScale: 1 },
		{ ...good }, // duplicate of `good`
		null, 3, 'str',
	];
	assert.deepEqual(parseModels([...bad, good]).map((m) => m.id), ['ok']);
	assert.equal(parseModels([{ ...good, defaultScale: LIMITS.minScale }, { ...good, id: 'max', defaultScale: LIMITS.maxScale }]).length, 2, 'range edges are valid');
});

test('M1: parseModels strips unknown keys; the shipped models.json passes through unchanged', async () => {
	const { readFileSync } = await import('node:fs');
	const out = parseModels([{ id: 'a', label: 'A', file: '/a.glb', defaultScale: 1, evil: true }]);
	assert.deepEqual(Object.keys(out[0]), ['id', 'label', 'file', 'defaultScale']);
	const shipped = JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8'));
	assert.deepEqual(parseModels(shipped), shipped, 'every shipped entry is valid (none silently skipped)');
});

// ---- model-limits: minScale 0.001 pinned with literal values -----------------------------------------

test('model-limits: LIMITS.minScale is literally 0.001 (maxScale 50 unchanged)', () => {
	assert.equal(LIMITS.minScale, 0.001);
	assert.equal(LIMITS.maxScale, 50);
});

test('model-limits: parseScene keeps scale 0.001 and rejects 0.0009 like any below-min value', () => {
	const kept = parseScene(scene({ elnur: roomOf([obj({ scale: [0.001, 0.001, 0.001] })]) }), opts);
	assert.deepEqual(kept.warnings, []);
	assert.deepEqual(kept.scene.rooms.elnur.objects[0].scale, [0.001, 0.001, 0.001]);
	assert.deepEqual(validateScene(scene({ elnur: roomOf([obj({ scale: [0.001, 0.5, 50] })]) }), opts), []);
	for (const bad of [[0.0009, 1, 1], [1, 0.0009, 1], [1, 1, 0.0009], [0, 1, 1], [-0.001, 1, 1]]) {
		const r = parseScene(scene({ elnur: roomOf([obj({ scale: bad })]) }), opts);
		assert.equal(r.scene.rooms.elnur.objects.length, 0, `scale ${JSON.stringify(bad)} drops the object like other out-of-range values`);
		assert.ok(r.warnings.length > 0, JSON.stringify(bad));
		assert.ok(validateScene(scene({ elnur: roomOf([obj({ scale: bad })]) }), opts).length > 0, JSON.stringify(bad));
	}
});

test('model-limits: serializeScene(parseScene()) round-trips 0.001 and 0.0015', () => {
	const r = parseScene(scene({ elnur: roomOf([obj({ scale: [0.001, 0.0015, 0.002] })]) }), opts);
	const text = serializeScene(r.scene);
	const again = parseScene(JSON.parse(text), opts);
	assert.deepEqual(again.warnings, []);
	assert.deepEqual(again.scene.rooms.elnur.objects[0].scale, [0.001, 0.0015, 0.002]);
	assert.equal(text, serializeScene(again.scene), 'stable');
});

test('model-limits: parseModels keeps defaultScale 0.001 and drops 0.0009', () => {
	const good = { id: 'tiny', label: 'Tiny', file: '/models/tiny.glb', defaultScale: 0.001 };
	assert.deepEqual(parseModels([good]), [good]);
	assert.deepEqual(parseModels([{ ...good, defaultScale: 0.0015 }]).map((m) => m.defaultScale), [0.0015]);
	assert.deepEqual(parseModels([{ ...good, defaultScale: 0.0009 }]), []);
	assert.deepEqual(parseModels([{ ...good, defaultScale: 0.0009 }, { ...good, id: 'ok' }]).map((m) => m.id), ['ok']);
});
