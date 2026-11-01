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

// ---------- object notes: optional title + paragraph (task object-paragraphs) ----------

const noteScene = (over: Record<string, unknown>) => scene({ elnur: roomOf([obj({ color: undefined, ...over })]) });
const parsedObj = (over: Record<string, unknown>) => parseScene(noteScene(over), opts).scene.rooms.elnur.objects[0];

test('notes: title and paragraph are optional and absent by default', () => {
	const o = parsedObj({});
	assert.equal('title' in o, false);
	assert.equal('paragraph' in o, false);
	assert.equal(LIMITS.maxTitle, 80);
	assert.equal(LIMITS.maxParagraph, 3000);
});

test('notes: title and paragraph are kept', () => {
	const r = parseScene(noteScene({ title: 'The chair', paragraph: 'Line 1\n\nLine 2' }), opts);
	assert.deepEqual(r.warnings, []);
	assert.equal(r.scene.rooms.elnur.objects[0].title, 'The chair');
	assert.equal(r.scene.rooms.elnur.objects[0].paragraph, 'Line 1\n\nLine 2');
});

test('notes: trimmed, CRLF and lone CR become LF, inner blank lines and indentation kept', () => {
	const o = parsedObj({ title: '  Hello \r\n', paragraph: '\r\n  a\r\nb\rc\r\n\r\n  d  \r\n' });
	assert.equal(o.title, 'Hello');
	assert.equal(o.paragraph, 'a\nb\nc\n\n  d');
});

test('notes: empty / whitespace-only values are dropped without a warning', () => {
	for (const v of ['', '   ', '\r\n\t \n']) {
		const r = parseScene(noteScene({ title: v, paragraph: v }), opts);
		assert.deepEqual(r.warnings, [], JSON.stringify(v));
		const o = r.scene.rooms.elnur.objects[0];
		assert.equal('title' in o, false);
		assert.equal('paragraph' in o, false);
	}
});

test('notes: exactly at the limit is kept (80 / 3000), measured after normalising', () => {
	const r = parseScene(noteScene({ title: 'a'.repeat(80), paragraph: 'b'.repeat(3000) }), opts);
	assert.deepEqual(r.warnings, []);
	assert.equal(r.scene.rooms.elnur.objects[0].title?.length, 80);
	assert.equal(r.scene.rooms.elnur.objects[0].paragraph?.length, 3000);
	// whitespace that is trimmed away does not count against the limit; CRLF counts as one character
	const padded = parseScene(noteScene({ title: `  ${'a'.repeat(80)}  `, paragraph: ('x'.repeat(99) + '\r\n').repeat(30).trim() }), opts);
	assert.deepEqual(padded.warnings, []);
	assert.equal(padded.scene.rooms.elnur.objects[0].paragraph?.length, 99 * 30 + 29);
});

test('notes: over the limit is dropped with a named warning, the object itself stays', () => {
	const r = parseScene(noteScene({ title: 'a'.repeat(81), paragraph: 'b'.repeat(3001) }), opts);
	assert.equal(r.ok, true);
	assert.equal(r.scene.rooms.elnur.objects.length, 1, 'the object is not dropped, only the field');
	const o = r.scene.rooms.elnur.objects[0];
	assert.equal('title' in o, false);
	assert.equal('paragraph' in o, false);
	assert.equal(r.warnings.length, 2);
	assert.match(r.warnings[0], /room "elnur" object #0 \(bed "bed-1"\)/);
	assert.match(r.warnings[0], /title is longer than 80/);
	assert.match(r.warnings[1], /paragraph is longer than 3000/);
});

test('notes: a non-string title/paragraph is dropped with a named warning', () => {
	for (const bad of [5, true, null, [], {}, ['x']]) {
		const r = parseScene(noteScene({ title: bad, paragraph: bad }), opts);
		const o = r.scene.rooms.elnur.objects[0];
		assert.equal('title' in o, false, JSON.stringify(bad));
		assert.equal('paragraph' in o, false, JSON.stringify(bad));
		assert.equal(r.warnings.length, 2, JSON.stringify(bad));
		assert.match(r.warnings[0], /title must be a string/);
		assert.match(r.warnings[1], /paragraph must be a string/);
	}
});

test('notes: validateScene blocks (non-empty) on an over-limit or non-string field and is empty for valid notes', () => {
	assert.deepEqual(validateScene(noteScene({ title: 'ok', paragraph: 'ok' }), opts), []);
	assert.equal(validateScene(noteScene({ paragraph: 'b'.repeat(3001) }), opts).length, 1);
	assert.equal(validateScene(noteScene({ title: 'a'.repeat(81) }), opts).length, 1);
	assert.equal(validateScene(noteScene({ title: 7 }), opts).length, 1);
});

test('notes: one bad field does not affect the other or the neighbours', () => {
	const r = parseScene(scene({ elnur: roomOf([
		obj({ id: 'a', title: 'a'.repeat(81), paragraph: 'fine' }),
		obj({ id: 'b', title: 'fine', paragraph: 3 }),
		obj({ id: 'c', paragraph: 'fine' }),
	]) }), opts);
	const [a, b, c] = r.scene.rooms.elnur.objects;
	assert.equal(a.title, undefined); assert.equal(a.paragraph, 'fine');
	assert.equal(b.title, 'fine'); assert.equal(b.paragraph, undefined);
	assert.equal(c.paragraph, 'fine');
	assert.equal(r.warnings.length, 2);
	assert.match(r.warnings[0], /"a"/); assert.match(r.warnings[1], /"b"/);
});

test('notes: serialize writes title/paragraph after color, in that order, only when set', () => {
	const objects = [
		obj({ id: 'a', title: 'T', paragraph: 'P' }),
		obj({ id: 'b', paragraph: 'only P' }),
		obj({ id: 'c', title: 'only T' }),
		obj({ id: 'd' }),
		obj({ id: 'e', color: undefined, paragraph: 'P', title: 'T' }), // key order in the INPUT must not matter
	];
	const r = parseScene(scene({ elnur: roomOf(objects) }), opts);
	const out = JSON.parse(serializeScene(r.scene)).rooms.elnur.objects as Record<string, unknown>[];
	const keys = out.map((o) => Object.keys(o).join());
	assert.equal(keys[0], 'id,type,position,rotation,scale,color,title,paragraph');
	assert.equal(keys[1], 'id,type,position,rotation,scale,color,paragraph');
	assert.equal(keys[2], 'id,type,position,rotation,scale,color,title');
	assert.equal(keys[3], 'id,type,position,rotation,scale,color');
	assert.equal(keys[4], 'id,type,position,rotation,scale,title,paragraph', 'no color key => notes follow scale directly');
});

test('notes: the text round-trips through serialize/parse unchanged (stable text)', () => {
	const payload = '<img src=x onerror=alert(1)>\n"q" \'s\' & <b>x</b>\n\tindent ☃ 😀';
	const r = parseScene(noteScene({ title: '<b>T</b>', paragraph: payload }), opts);
	const text = serializeScene(r.scene);
	const again = parseScene(JSON.parse(text), opts);
	assert.deepEqual(again.warnings, []);
	assert.equal(serializeScene(again.scene), text);
	assert.equal(again.scene.rooms.elnur.objects[0].paragraph, payload, '<img onerror> stays a literal string, nothing is stripped or escaped');
	assert.equal(again.scene.rooms.elnur.objects[0].title, '<b>T</b>');
});

test('notes: the committed scene.json at HEAD round-trips byte-identical (no notes => no new keys)', async () => {
	const { execFileSync } = await import('node:child_process');
	const { readFileSync } = await import('node:fs');
	let head: string;
	try {
		head = execFileSync('git', ['show', 'HEAD:src/data/scene.json'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
	} catch {
		head = readFileSync(new URL('../src/data/scene.json', import.meta.url), 'utf8'); // no git: fall back to the working copy
	}
	const models = JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8')).map((m: { id: string }) => m.id);
	const r = parseScene(JSON.parse(head), { slugs: SLUGS, modelIds: models });
	assert.deepEqual(r.warnings, []);
	assert.equal(serializeScene(r.scene), head);
});

test('notes: the working scene.json (seeded or not) also round-trips byte-identical and warning-free', async () => {
	const { readFileSync } = await import('node:fs');
	const text = readFileSync(new URL('../src/data/scene.json', import.meta.url), 'utf8');
	const models = JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8')).map((m: { id: string }) => m.id);
	const r = parseScene(JSON.parse(text), { slugs: SLUGS, modelIds: models });
	assert.deepEqual(r.warnings, []);
	assert.equal(serializeScene(r.scene), text);
});

test('notes: normalizeNoteText and restoreKeyOrder (shared with the editor)', async () => {
	const { normalizeNoteText, restoreKeyOrder } = await import('../src/data/scene.ts');
	assert.equal(normalizeNoteText(' \r\na\r\n b\r '), 'a\n b');
	assert.equal(normalizeNoteText('   '), '');
	const o: Record<string, unknown> = { id: 'x', type: 'bed', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], paragraph: 'P', title: 'T', color: '#000000' };
	restoreKeyOrder(o as never);
	assert.equal(Object.keys(o).join(), 'id,type,position,rotation,scale,color,title,paragraph');
	const bare: Record<string, unknown> = { id: 'x', type: 'bed', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], paragraph: 'P' };
	restoreKeyOrder(bare as never);
	assert.equal(Object.keys(bare).join(), 'id,type,position,rotation,scale,paragraph', 'absent keys are not created');
});

// ---------- round 2: warnings of kept objects only, never throws, '<' escaping of the embedded JSON ----------

test('notes r2: the warning text names room, index, type and id, and the limit', () => {
	const r = parseScene(scene({ elnur: roomOf([obj({ paragraph: 'p'.repeat(3001) })]) }), opts);
	assert.deepEqual(r.warnings, ['room "elnur" object #0 (bed "bed-1"): paragraph is longer than 3000 characters (3001), field dropped']);
	const t = parseScene(scene({ elnur: roomOf([obj({ title: 'x'.repeat(81) })]) }), opts);
	assert.deepEqual(t.warnings, ['room "elnur" object #0 (bed "bed-1"): title is longer than 80 characters (81), field dropped']);
	const n = parseScene(scene({ elnur: roomOf([obj({ paragraph: 42 })]) }), opts);
	assert.deepEqual(n.warnings, ['room "elnur" object #0 (bed "bed-1"): paragraph must be a string, field dropped']);
});

test('notes r2: a dropped object reports only why it was dropped, not its note problems', () => {
	const r = parseScene(scene({ elnur: roomOf([
		obj({ id: 'bad', type: 'nope', paragraph: 'z'.repeat(5000) }),
		obj({ id: 'ok', paragraph: 'fine' }),
		obj({ id: 'ok', paragraph: 'q'.repeat(5000) }), // duplicate id: dropped
	]) }), opts);
	assert.equal(r.warnings.length, 2);
	assert.match(r.warnings[0], /unknown type "nope", dropped$/);
	assert.match(r.warnings[1], /duplicate id "ok", dropped$/);
	assert.equal(r.scene.rooms.elnur.objects.length, 1);
});

test('notes r2: parseScene never throws whatever the title/paragraph is (sweep), and bad ones are always dropped + reported', () => {
	const values: unknown[] = [null, true, false, 0, -1, 1.5, NaN, Infinity, [], [1], {}, { a: 1 }, () => 1, Symbol.iterator, 10n, 'x'.repeat(100000), '\u0000', '\ud800'];
	for (const v of values) {
		for (const key of ['title', 'paragraph']) {
			let r;
			assert.doesNotThrow(() => { r = parseScene(noteScene({ [key]: v }), opts); }, `${key}=${String(typeof v)}`);
			const o = (r as ReturnType<typeof parseScene>).scene.rooms.elnur.objects[0];
			if (typeof v !== 'string') {
				assert.equal(key in o, false);
				assert.equal((r as ReturnType<typeof parseScene>).warnings.length, 1);
			}
		}
	}
});

test('notes r2: a scene.json read by the build (load-scene logic) with over-limit notes still yields a usable scene + warnings', () => {
	const text = JSON.stringify(scene({ elnur: roomOf([obj({ id: 'a', paragraph: 'p'.repeat(3001) }), obj({ id: 'b', paragraph: 'ok' })]) }));
	const { scene: s, warnings, ok } = parseScene(JSON.parse(text), opts);
	assert.equal(ok, true);
	assert.equal(warnings.length, 1);
	assert.deepEqual(s.rooms.elnur.objects.map((o) => [o.id, o.paragraph ?? null]), [['a', null], ['b', 'ok']]);
});

test("notes r2: the page embeds scene JSON with '<' written as \\u003c; it parses back to the exact original text", () => {
	const texts = ['<script>alert(1)</script>', '</script><script>x', '<img src=x onerror=alert(1)>', '<!-- x -->', 'a < b > c & "d" \'e\'', '\\u003c literal backslash-u', '<<<'];
	for (const t of texts) {
		const embedded = JSON.stringify({ paragraph: t, title: t }).replace(/</g, '\\u003c');
		assert.equal(embedded.includes('<'), false, 'no raw < left');
		const back = JSON.parse(embedded);
		assert.equal(back.paragraph, t);
		assert.equal(back.title, t);
	}
	// and through the scene model end to end
	const r = parseScene(noteScene({ paragraph: texts.join('\n') }), opts);
	const embedded = JSON.stringify(r.scene).replace(/</g, '\\u003c');
	assert.equal(parseScene(JSON.parse(embedded), opts).scene.rooms.elnur.objects[0].paragraph, texts.join('\n'));
});
