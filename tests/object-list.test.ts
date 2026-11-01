// Unit tests for src/scripts/admin/object-list.ts (rows of the "Objects in this room" list). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildObjectRows, objectRowsSignature, NOT_AVAILABLE } from '../src/scripts/admin/object-list.ts';
import type { ListedObject } from '../src/scripts/admin/object-list.ts';

const LABELS: Record<string, string> = { chair: 'Chair', rug: 'Rug', bed: 'Bed', 'model:p': 'Piano', 'model:p2': 'Piano', 'model:s': 'Sofa' };
const labelOf = (type: string) => LABELS[type];
const o = (id: string, type: string, shown = true): ListedObject => ({ id, type, shown });
const labels = (list: ListedObject[], fn = labelOf) => buildObjectRows(list, fn).map((r) => r.label);

test('empty room: no rows, empty signature', () => {
	assert.deepEqual(buildObjectRows([], labelOf), []);
	assert.equal(objectRowsSignature([]), '');
});

test('a type that occurs once is not numbered', () => {
	assert.deepEqual(labels([o('a', 'chair')]), ['Chair']);
	assert.deepEqual(labels([o('a', 'chair'), o('b', 'rug'), o('c', 'bed')]), ['Chair', 'Rug', 'Bed']);
});

test('several of one type are numbered per type from 1, in scene order', () => {
	assert.deepEqual(labels([o('a', 'chair'), o('b', 'chair'), o('c', 'chair')]), ['Chair 1', 'Chair 2', 'Chair 3']);
});

test('numbering is per type: mixed types, only repeated ones are numbered, order is the scene order', () => {
	const rows = buildObjectRows([o('a', 'chair'), o('b', 'rug'), o('c', 'chair'), o('d', 'bed'), o('e', 'rug')], labelOf);
	assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
	assert.deepEqual(rows.map((r) => r.label), ['Chair 1', 'Rug 1', 'Chair 2', 'Bed', 'Rug 2']);
});

test('rows keep the order of the input, never re-sorted', () => {
	const input = [o('z', 'rug'), o('m', 'chair'), o('a', 'bed')];
	assert.deepEqual(buildObjectRows(input, labelOf).map((r) => r.id), ['z', 'm', 'a']);
});

test('model objects use the model label (not the model:id) and are numbered like other types', () => {
	assert.deepEqual(labels([o('a', 'model:p')]), ['Piano']);
	assert.deepEqual(labels([o('a', 'model:p'), o('b', 'model:p')]), ['Piano 1', 'Piano 2']);
});

test('two models that share a label are numbered together', () => {
	assert.deepEqual(labels([o('a', 'model:p'), o('b', 'model:p2')]), ['Piano 1', 'Piano 2']);
});

test('an unknown label falls back to the raw type name', () => {
	assert.deepEqual(labels([o('a', 'mystery')]), ['mystery']);
	assert.deepEqual(labels([o('a', 'mystery'), o('b', 'mystery')]), ['mystery 1', 'mystery 2']);
});

test('available rows: available true, delete label "Delete <label>" (numbered too)', () => {
	const rows = buildObjectRows([o('a', 'chair'), o('b', 'chair'), o('c', 'rug')], labelOf);
	assert.deepEqual(rows.map((r) => r.available), [true, true, true]);
	assert.deepEqual(rows.map((r) => r.deleteLabel), ['Delete Chair 1', 'Delete Chair 2', 'Delete Rug']);
});

test('unavailable rows: "<type> — not available", not available, no delete label', () => {
	const rows = buildObjectRows([o('a', 'model:gone', false)], labelOf);
	assert.equal(rows[0].label, `model:gone${NOT_AVAILABLE}`);
	assert.equal(rows[0].label, 'model:gone — not available');
	assert.equal(rows[0].available, false);
	assert.equal(rows[0].deleteLabel, null);
});

test('unavailable rows use the raw type even if a label exists, and never get a number', () => {
	const rows = buildObjectRows([o('a', 'model:p', false), o('b', 'model:p', false)], labelOf);
	assert.deepEqual(rows.map((r) => r.label), ['model:p — not available', 'model:p — not available']);
});

test('unavailable objects do not count towards the numbering of available ones', () => {
	const rows = buildObjectRows([o('a', 'model:p'), o('b', 'model:p', false), o('c', 'chair')], labelOf);
	assert.deepEqual(rows.map((r) => r.label), ['Piano', 'model:p — not available', 'Chair']);
	const two = buildObjectRows([o('a', 'chair'), o('b', 'chair', false), o('c', 'chair')], labelOf);
	assert.deepEqual(two.map((r) => r.label), ['Chair 1', 'chair — not available', 'Chair 2']);
});

test('does not mutate its input and returns one row per object', () => {
	const input = [o('a', 'chair'), o('b', 'chair')];
	const copy = structuredClone(input);
	const rows = buildObjectRows(input, labelOf);
	assert.equal(rows.length, input.length);
	assert.deepEqual(input, copy);
});

test('labelOf is called with the object type', () => {
	const seen: string[] = [];
	buildObjectRows([o('a', 'chair'), o('b', 'model:p')], (t) => { seen.push(t); return labelOf(t); });
	assert.ok(seen.includes('chair') && seen.includes('model:p'));
});

// ---------- signature ----------

const sig = (list: ListedObject[]) => objectRowsSignature(buildObjectRows(list, labelOf));

test('signature: identical lists give identical signatures', () => {
	assert.equal(sig([o('a', 'chair'), o('b', 'rug')]), sig([o('a', 'chair'), o('b', 'rug')]));
});

test('signature changes on add, delete, reorder and type change', () => {
	const base = [o('a', 'chair'), o('b', 'rug'), o('c', 'bed')];
	const s0 = sig(base);
	assert.notEqual(sig([...base, o('d', 'bed')]), s0, 'add');
	assert.notEqual(sig([o('a', 'chair'), o('c', 'bed')]), s0, 'delete');
	assert.notEqual(sig([o('b', 'rug'), o('a', 'chair'), o('c', 'bed')]), s0, 'reorder');
	assert.notEqual(sig([o('a', 'chair'), o('b', 'bed'), o('c', 'bed')]), s0, 'type change');
});

test('signature changes when numbering changes (a second chair appears / one is deleted)', () => {
	assert.notEqual(sig([o('a', 'chair')]), sig([o('a', 'chair'), o('b', 'chair')]));
	assert.notEqual(sig([o('a', 'chair'), o('b', 'chair')]), sig([o('b', 'chair')]));
});

test('signature changes when a model label changes or availability flips', () => {
	const list = [o('a', 'model:p')];
	const renamed = objectRowsSignature(buildObjectRows(list, () => 'Grand piano'));
	assert.notEqual(renamed, sig(list), 'label change');
	assert.notEqual(sig([o('a', 'model:p', false)]), sig(list), 'availability');
});

test('signature does not change for colour or transform edits (not part of the listed data)', () => {
	const a = [{ ...o('a', 'chair'), color: '#ff0000', position: [0, 0, 0] }, o('b', 'rug')] as ListedObject[];
	const b = [{ ...o('a', 'chair'), color: '#00ff00', position: [3, 0, 1] }, o('b', 'rug')] as ListedObject[];
	assert.equal(sig(a), sig(b));
});

test('signature is not fooled by ids that contain separators or by label/id boundaries', () => {
	const x = objectRowsSignature([{ id: 'a', label: 'b', available: true, deleteLabel: null }]);
	const y = objectRowsSignature([{ id: 'ab', label: '', available: true, deleteLabel: null }]);
	assert.notEqual(x, y);
});

// ---------- "has note" marker (task object-paragraphs) ----------

test('hasNote: rows carry the flag of available objects that have a paragraph; absent flag = false', () => {
	const rows = buildObjectRows([
		{ ...o('a', 'chair'), hasNote: true },
		o('b', 'chair'),
		{ ...o('c', 'rug'), hasNote: false },
	], labelOf);
	assert.deepEqual(rows.map((r) => r.hasNote), [true, false, false]);
	assert.ok(rows.every((r) => typeof r.hasNote === 'boolean'), 'always a boolean');
});

test('hasNote: never set on unavailable rows even if the object has a note', () => {
	const rows = buildObjectRows([{ ...o('a', 'model:gone', false), hasNote: true }], labelOf);
	assert.equal(rows[0].available, false);
	assert.equal(rows[0].hasNote, false);
});

test('hasNote: the flag does not change numbering or labels', () => {
	const rows = buildObjectRows([{ ...o('a', 'chair'), hasNote: true }, o('b', 'chair')], labelOf);
	assert.deepEqual(rows.map((r) => r.label), ['Chair 1', 'Chair 2']);
	assert.deepEqual(rows.map((r) => r.deleteLabel), ['Delete Chair 1', 'Delete Chair 2']);
});

test('hasNote: the signature changes when the marker appears or disappears (so the list is rebuilt), nothing else does', () => {
	const plain = sig([o('a', 'chair'), o('b', 'rug')]);
	const noted = sig([{ ...o('a', 'chair'), hasNote: true }, o('b', 'rug')]);
	assert.notEqual(plain, noted, 'note added');
	assert.notEqual(noted, sig([{ ...o('a', 'chair'), hasNote: true }, { ...o('b', 'rug'), hasNote: true }]), 'second note added');
	assert.equal(noted, sig([{ ...o('a', 'chair'), hasNote: true, color: '#fff' } as ListedObject, o('b', 'rug')]), 'colour edit alone does not');
	assert.equal(plain, sig([{ ...o('a', 'chair'), hasNote: false }, o('b', 'rug')]), 'false == absent');
});
