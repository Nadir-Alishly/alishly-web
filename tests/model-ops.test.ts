// Unit tests for src/scripts/admin/model-ops.ts (merging pending library changes into the REMOTE models.json,
// fail-closed checks, retry on conflict). The GitHub client is a fake. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildModelCommit, saveModels, modelUsage, describeUsage, canonicalEntry, serializeModels, commitMessage, MODELS_JSON_PATH,
	gitBlobSha, findSavedImports,
} from '../src/scripts/admin/model-ops.ts';
import type { PendingModels } from '../src/scripts/admin/model-ops.ts';
import { GithubError, createGithubClient, DEFAULT_TARGET, API_BASE } from '../src/scripts/admin/github.ts';
import type { FileChange, GithubClient } from '../src/scripts/admin/github.ts';
import { emptyScene, parseModels } from '../src/data/scene.ts';
import { makeBoxGlb } from './helpers/gltf-fixtures.ts';

const SLUGS = ['elnur', 'sabina', 'nadir', 'chinara', 'alibala', 'elkhan', 'fazil'];
const SCENE_PATH = 'src/data/scene.json';
const GLB = makeBoxGlb();

const entry = (id: string, label = id, defaultScale = 1, file = `/models/${id}.glb`) => ({ id, label, file, defaultScale });
const modelsText = (...entries: ReturnType<typeof entry>[]) => `${JSON.stringify(entries, null, '\t')}\n`;
const obj = (id: string, type: string) => ({ id, type, position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] });
function sceneText(objectsBySlug: Record<string, Array<ReturnType<typeof obj>>> = {}) {
	const scene = emptyScene(SLUGS);
	for (const [slug, objects] of Object.entries(objectsBySlug)) scene.rooms[slug].objects = objects as never;
	return JSON.stringify(scene);
}
const pending = (added: Array<{ id: string; label?: string; scale?: number }> = [], removed: string[] = []): PendingModels => ({
	added: added.map((a) => ({ entry: entry(a.id, a.label ?? a.id, a.scale ?? 1), bytes: GLB })),
	removed,
});
const build = (remote: string, scene: string, p: PendingModels, savedIds?: ReadonlySet<string>) =>
	buildModelCommit({ remoteModelsText: remote, remoteSceneText: scene, slugs: SLUGS, pending: p, savedIds });
const failsWith = (fn: () => unknown, kind: string, re?: RegExp) =>
	assert.throws(fn, (e: unknown) => e instanceof GithubError && e.kind === kind && (!re || re.test(e.message)), `expected GithubError ${kind} ${re ?? ''}`);

// ---- pure helpers ---------------------------------------------------------------------------------------

test('canonicalEntry: fixed key order and a path derived from the id only', () => {
	const e = canonicalEntry('chair', 'My chair', 0.5);
	assert.deepEqual(e, { id: 'chair', label: 'My chair', file: '/models/chair.glb', defaultScale: 0.5 });
	assert.deepEqual(Object.keys(e), ['id', 'label', 'file', 'defaultScale']);
});

test('serializeModels: tab-indented JSON with one trailing newline, [] for empty, round-trips through parseModels', () => {
	assert.equal(serializeModels([]), '[]\n');
	const text = serializeModels([entry('a', 'A', 2), entry('b')]);
	assert.ok(text.startsWith('[\n\t{\n\t\t"id": "a"'), text);
	assert.ok(text.endsWith('}\n]\n'));
	assert.equal(text.endsWith('\n\n'), false);
	assert.deepEqual(parseModels(JSON.parse(text)), [entry('a', 'A', 2), entry('b')]);
});

test('commitMessage: counts, omits zero parts, uses the minus sign', () => {
	assert.equal(commitMessage(2, 1), 'admin: update model library (+2, −1)');
	assert.equal(commitMessage(1, 0), 'admin: update model library (+1)');
	assert.equal(commitMessage(0, 3), 'admin: update model library (−3)');
});

test('modelUsage counts objects per room and skips rooms without any; describeUsage uses room names', () => {
	const scene = JSON.parse(sceneText({
		elnur: [obj('o1', 'model:chair'), obj('o2', 'model:chair'), obj('o3', 'model:lamp'), obj('o4', 'box')],
		fazil: [obj('o5', 'model:chair')],
	}));
	assert.deepEqual(modelUsage(scene, 'chair'), [{ slug: 'elnur', count: 2 }, { slug: 'fazil', count: 1 }]);
	assert.deepEqual(modelUsage(scene, 'lamp'), [{ slug: 'elnur', count: 1 }]);
	assert.deepEqual(modelUsage(scene, 'chai'), [], 'prefix of an id is not a match');
	assert.deepEqual(modelUsage(scene, 'box'), [], 'a primitive is not a model');
	assert.equal(describeUsage([{ slug: 'elnur', count: 2 }, { slug: 'fazil', count: 1 }], new Map([['elnur', "Elnur's room"]])), "Elnur's room: 2, fazil: 1");
});

// ---- buildModelCommit: merging --------------------------------------------------------------------------

test('buildModelCommit: add into an empty remote list -> glb + models.json, canonical entry', () => {
	const c = build('[]\n', sceneText(), pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]));
	assert.equal(c.message, 'admin: update model library (+1)');
	assert.deepEqual(c.changes.map((x) => x.path), ['public/models/chair.glb', MODELS_JSON_PATH]);
	assert.deepEqual((c.changes[0] as { bytes: Uint8Array }).bytes, GLB);
	assert.equal(c.modelsText, serializeModels([entry('chair', 'My chair', 0.5)]));
	assert.equal((c.changes[1] as { text: string }).text, c.modelsText);
	assert.equal(c.added, 1);
	assert.equal(c.removed, 0);
});

test('buildModelCommit: the pending entry is rewritten canonically (file path from the id, never from input)', () => {
	const p: PendingModels = { added: [{ entry: { id: 'chair', label: 'C', file: '../../.github/workflows/x.yml', defaultScale: 1 }, bytes: GLB }], removed: [] };
	const c = build('[]', sceneText(), p);
	assert.equal(JSON.parse(c.modelsText)[0].file, '/models/chair.glb');
	assert.equal(c.changes[0].path, 'public/models/chair.glb');
});

test('buildModelCommit: merges into the REMOTE list — models added elsewhere are kept, order preserved, new ones appended', () => {
	const remote = modelsText(entry('zeta', 'Zeta', 2), entry('alpha', 'Alpha'));
	const c = build(remote, sceneText(), pending([{ id: 'new-one' }]));
	assert.deepEqual(JSON.parse(c.modelsText).map((m: { id: string }) => m.id), ['zeta', 'alpha', 'new-one']);
	assert.equal(JSON.parse(c.modelsText)[0].defaultScale, 2, 'untouched remote entries keep their values');
});

test('buildModelCommit: delete removes the entry and the canonical glb, keeps the others', () => {
	const remote = modelsText(entry('a'), entry('b'), entry('c'));
	const c = build(remote, sceneText(), pending([], ['b']));
	assert.deepEqual(JSON.parse(c.modelsText).map((m: { id: string }) => m.id), ['a', 'c']);
	assert.deepEqual(c.changes, [{ path: 'public/models/b.glb', delete: true }, { path: MODELS_JSON_PATH, text: c.modelsText }]);
	assert.equal(c.message, 'admin: update model library (−1)');
	assert.equal(c.removed, 1);
});

test('buildModelCommit: add + delete in one commit (+n, −m)', () => {
	const c = build(modelsText(entry('old')), sceneText(), pending([{ id: 'n1' }, { id: 'n2' }], ['old']));
	assert.equal(c.message, 'admin: update model library (+2, −1)');
	assert.deepEqual(c.changes.map((x) => x.path), ['public/models/old.glb', 'public/models/n1.glb', 'public/models/n2.glb', MODELS_JSON_PATH]);
	assert.deepEqual(JSON.parse(c.modelsText).map((m: { id: string }) => m.id), ['n1', 'n2']);
});

test('buildModelCommit: a hand-made entry whose file is not /models/<id>.glb loses the entry but its file is NOT deleted', () => {
	const remote = modelsText(entry('hand', 'Hand', 1, '/models/other-name.glb'), entry('keep'));
	const c = build(remote, sceneText(), pending([], ['hand']));
	assert.deepEqual(c.changes.map((x) => x.path), [MODELS_JSON_PATH]);
	assert.deepEqual(JSON.parse(c.modelsText).map((m: { id: string }) => m.id), ['keep']);
});

test('buildModelCommit: a delete that is already gone remotely is a no-op for that id and is not counted', () => {
	const c = build(modelsText(entry('a')), sceneText(), pending([{ id: 'n' }], ['ghost']));
	assert.equal(c.removed, 0);
	assert.equal(c.message, 'admin: update model library (+1)');
	assert.ok(!c.changes.some((x) => x.path.includes('ghost')));
});

test('buildModelCommit: never touches paths outside public/models/<id>.glb and models.json', () => {
	const c = build(modelsText(entry('a'), entry('b')), sceneText(), pending([{ id: 'x' }], ['a']));
	for (const ch of c.changes) assert.match(ch.path, /^(public\/models\/[a-z0-9-]+\.glb|src\/data\/models\.json)$/);
	assert.ok(!c.changes.some((x) => x.path === SCENE_PATH), 'scene.json is read, never written');
});

// ---- buildModelCommit: fail closed ----------------------------------------------------------------------

test('buildModelCommit fails closed: a pending delete still used in the REMOTE scene -> rejected, naming rooms and counts', () => {
	const scene = sceneText({ elnur: [obj('o1', 'model:chair'), obj('o2', 'model:chair')], fazil: [obj('o3', 'model:chair')] });
	failsWith(() => build(modelsText(entry('chair')), scene, pending([], ['chair'])), 'rejected', /"chair".*elnur: 2, fazil: 1/);
});

test('buildModelCommit: usage of a DIFFERENT model does not block the delete', () => {
	const scene = sceneText({ elnur: [obj('o1', 'model:lamp')] });
	assert.doesNotThrow(() => build(modelsText(entry('chair'), entry('lamp')), scene, pending([], ['chair'])));
});

test('buildModelCommit fails closed: remote models.json unreadable', () => {
	failsWith(() => build('not json', sceneText(), pending([{ id: 'x' }])), 'bad-response', /models\.json/);
	failsWith(() => build('', sceneText(), pending([{ id: 'x' }])), 'bad-response');
	failsWith(() => build('{"id":"a"}', sceneText(), pending([{ id: 'x' }])), 'bad-response', /cannot read/i);
	failsWith(() => build('null', sceneText(), pending([{ id: 'x' }])), 'bad-response');
});

test('buildModelCommit fails closed: remote models.json has entries the page would drop (never silently rewritten)', () => {
	const remote = JSON.stringify([entry('good'), { id: 'bad id!', label: 'x', file: '/models/x.glb', defaultScale: 1 }, { nope: true }]);
	failsWith(() => build(remote, sceneText(), pending([{ id: 'x' }])), 'bad-response', /cannot read/i);
});

test('buildModelCommit fails closed: remote scene.json unreadable (invalid JSON / not a scene / empty)', () => {
	failsWith(() => build('[]', 'oops', pending([], [])), 'bad-response', /scene/i);
	failsWith(() => build('[]', '', pending([{ id: 'x' }])), 'bad-response');
	failsWith(() => build('[]', 'null', pending([{ id: 'x' }])), 'bad-response');
	failsWith(() => build('[]', '[]', pending([{ id: 'x' }])), 'bad-response');
	failsWith(() => build('[]', '{"version":99}', pending([{ id: 'x' }])), 'bad-response');
});

test('buildModelCommit: scene is checked even when only adding (an unreadable scene still blocks the save)', () => {
	failsWith(() => build('[]', 'garbage', pending([{ id: 'x' }])), 'bad-response');
});

test('buildModelCommit: a DIFFERENT model with the imported id now exists remotely -> rejected (case-insensitive), nothing merged', () => {
	failsWith(() => build(modelsText(entry('chair', 'Other label')), sceneText(), pending([{ id: 'chair', label: 'Mine' }])), 'rejected', /different model.*"chair".*exists/i);
	failsWith(() => build(modelsText(entry('chair', 'chair', 2)), sceneText(), pending([{ id: 'chair', scale: 1 }])), 'rejected', /different model/i);
	failsWith(() => build(modelsText(entry('chair', 'chair', 1, '/models/elsewhere.glb')), sceneText(), pending([{ id: 'chair' }])), 'rejected');
	failsWith(() => build(modelsText(entry('Chair')), sceneText(), pending([{ id: 'chair' }])), 'rejected', /different model/i);
});

// m4: a lost ref-PATCH answer leaves the entry on GitHub; the retry must not ask the user to rename.
test('buildModelCommit (m4): an import whose remote entry is IDENTICAL and whose file is VERIFIED (savedIds) is already saved: skipped, no blob, not counted', () => {
	const remote = modelsText(entry('chair', 'My chair', 0.5), entry('other'));
	const c = build(remote, sceneText(), pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]), new Set(['chair']));
	assert.deepEqual(c.changes, [], 'nothing to commit');
	assert.equal(c.added, 0);
	assert.equal(c.removed, 0);
});

test('buildModelCommit (M1): identical metadata WITHOUT verified bytes (no savedIds / id not in savedIds) is rejected with the "file missing or not the same" message', () => {
	const remote = modelsText(entry('chair', 'My chair', 0.5));
	const p = pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]);
	const NOT_VERIFIED = /entry "chair" already exists on GitHub, but its file there is missing or not the same.*another name/i;
	failsWith(() => build(remote, sceneText(), p), 'rejected', NOT_VERIFIED);
	failsWith(() => build(remote, sceneText(), p, new Set()), 'rejected', NOT_VERIFIED);
	failsWith(() => build(remote, sceneText(), p, new Set(['other'])), 'rejected', NOT_VERIFIED);
});

test('buildModelCommit (M1): DIFFERENT metadata keeps the "different model" wording, identical metadata gets the file wording (the two texts are not mixed)', () => {
	const differentLabel = modelsText(entry('chair', 'Other label', 0.5));
	const p = pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]);
	failsWith(() => build(differentLabel, sceneText(), p, new Set(['chair'])), 'rejected', /different model.*"chair".*another name/i);
	assert.throws(() => build(differentLabel, sceneText(), p), (e: unknown) => e instanceof GithubError && !/its file there is missing/i.test(e.message));
	assert.throws(() => build(modelsText(entry('chair', 'My chair', 0.5)), sceneText(), p), (e: unknown) => e instanceof GithubError && !/different model/i.test(e.message));
});

test('buildModelCommit (m4): a partly-saved batch commits only the new imports', () => {
	const remote = modelsText(entry('a', 'a', 1));
	const c = build(remote, sceneText(), pending([{ id: 'a' }, { id: 'b' }]), new Set(['a']));
	assert.deepEqual(c.changes.map((x) => x.path), ['public/models/b.glb', MODELS_JSON_PATH]);
	assert.equal(c.added, 1);
	assert.deepEqual(JSON.parse(c.modelsText).map((m: { id: string }) => m.id), ['a', 'b']);
	assert.equal(c.message, 'admin: update model library (+1)');
});

// m3: nothing left to do must not become an empty commit with the message "()".
test('buildModelCommit (m3): nothing to add or remove -> no changes and no commit message', () => {
	const c = build(modelsText(entry('a')), sceneText(), pending([], ['ghost']));
	assert.deepEqual(c.changes, []);
	assert.equal(c.added + c.removed, 0);
	const none = build('[]\n', sceneText(), pending([], []));
	assert.deepEqual(none.changes, []);
});

test('saveModels (m3): a no-op save returns commitSha null and NEVER calls commitFiles', async () => {
	const f = fakeClient([{ head: 'H1', models: modelsText(entry('a')), scene: sceneText() }]);
	const r = await saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([], ['already-gone']) });
	assert.deepEqual(r, { commitSha: null, added: 0, removed: 0 });
	assert.equal(f.commitCount(), 0);
	assert.ok(!f.log.some((l) => l.startsWith('commitFiles')));
	assert.ok(f.log.includes('getHead'), 'it still read the remote to find that out');
});

test('saveModels (m3/m4): re-saving after a lost PATCH answer (identical entry AND identical bytes) is a clean no-op, not a rejection', async () => {
	const saved = modelsText(entry('chair', 'My chair', 0.5));
	const f = fakeClient([{ head: 'H2', models: saved, scene: sceneText(), blobs: { 'public/models/chair.glb': await gitBlobSha(GLB) } }]);
	const r = await saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]) });
	assert.equal(r.commitSha, null);
	assert.equal(f.commitCount(), 0);
	assert.ok(f.log.includes('getBlobSha public/models/chair.glb@H2'), 'the file was verified by its blob sha');
});

test('saveModels (M1): identical entry but DIFFERENT bytes under the same id -> rejected with the rename message, nothing written', async () => {
	const saved = modelsText(entry('chair', 'My chair', 0.5));
	const f = fakeClient([{ head: 'H2', models: saved, scene: sceneText(), blobs: { 'public/models/chair.glb': 'f'.repeat(40) } }]);
	await assert.rejects(
		() => saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]) }),
		(e: unknown) => e instanceof GithubError && e.kind === 'rejected' && /entry "chair" already exists on GitHub, but its file there is missing or not the same.*another name/i.test(e.message),
	);
	assert.equal(f.commitCount(), 0);
});

test('saveModels (M1): identical entry whose .glb is MISSING on GitHub (null sha) -> rejected, not treated as saved', async () => {
	const f = fakeClient([{ head: 'H2', models: modelsText(entry('chair', 'My chair', 0.5)), scene: sceneText() }]);
	await assert.rejects(
		() => saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]) }),
		(e: unknown) => e instanceof GithubError && e.kind === 'rejected' && /entry "chair" already exists on GitHub, but its file there is missing or not the same/i.test(e.message),
	);
	assert.equal(f.commitCount(), 0);
});

test('saveModels (M1): normal saves make NO getBlobSha request (only identical remote entries are verified)', async () => {
	const f = fakeClient([{ head: 'H1', models: modelsText(entry('other')), scene: sceneText() }]);
	await saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'fresh' }]) });
	assert.ok(!f.log.some((l) => l.startsWith('getBlobSha')));
	const g = fakeClient([{ head: 'H1', models: '[]', scene: sceneText() }]);
	await saveModels({ github: g.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'fresh' }], []) });
	assert.ok(!g.log.some((l) => l.startsWith('getBlobSha')));
});

test('saveModels (M1): the check runs again on the retry, at the NEW head', async () => {
	const entries = modelsText(entry('chair', 'My chair', 0.5));
	const f = fakeClient(
		[
			{ head: 'H1', models: '[]', scene: sceneText() },
			{ head: 'H2', models: entries, scene: sceneText(), blobs: { 'public/models/chair.glb': await gitBlobSha(GLB) } },
		],
		{ commit: async (n) => { if (n === 1) throw new GithubError('conflict', 'moved', 422); return { commitSha: 'x' }; } },
	);
	const r = await saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]) });
	assert.equal(r.commitSha, null, 'the other tab saved the very same model: nothing left to commit');
	assert.equal(f.commitCount(), 1);
	assert.ok(f.log.includes('getBlobSha public/models/chair.glb@H2'));
});

// ---- gitBlobSha / findSavedImports ----------------------------------------------------------------------------------

test('gitBlobSha: known vectors (empty blob, "hello\\n") and Git\'s "blob <len>\\0" framing', async () => {
	assert.equal(await gitBlobSha(new Uint8Array()), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
	assert.equal(await gitBlobSha(new TextEncoder().encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
	assert.equal(await gitBlobSha(new TextEncoder().encode('test content\n')), 'd670460b4b4aece5915caf5c68d12f560a9fe3e4');
});

test('gitBlobSha: matches Node\'s own sha1 over "blob <len>\\0"+bytes for random, 0xFF-heavy and large inputs; honours byteOffset views', async () => {
	const { createHash } = await import('node:crypto');
	const ref = (b: Uint8Array) => createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
	for (const bytes of [Uint8Array.from([0xff, 0xfe, 0, 1, 2]), new Uint8Array(100_000).map((_, i) => (i * 131 + 7) & 255), new Uint8Array(3 * 1024 * 1024).fill(255), GLB]) {
		assert.equal(await gitBlobSha(bytes), ref(bytes));
	}
	const backing = new Uint8Array(GLB.length + 9);
	backing.set(GLB, 9);
	assert.equal(await gitBlobSha(backing.subarray(9)), ref(GLB), 'a subarray view hashes only its own bytes');
	assert.match(await gitBlobSha(GLB), /^[0-9a-f]{40}$/);
});

test('findSavedImports: identical entry + identical sha -> saved; different sha, null sha, different entry, bad JSON -> not saved', async () => {
	const e = canonicalEntry('chair', 'Chair', 1);
	const bytes = Uint8Array.from([1, 2, 3, 4]);
	const added = [{ entry: e, bytes }];
	const asks: string[] = [];
	const mk = (sha: string | null) => ({ getBlobSha: async (path: string, ref: string) => { asks.push(`${path}@${ref}`); return sha; } });
	const text = JSON.stringify([e]);
	assert.deepEqual([...(await findSavedImports(mk(await gitBlobSha(bytes)), text, added, 'h1'))], ['chair']);
	assert.deepEqual(asks, ['public/models/chair.glb@h1']);
	assert.deepEqual([...(await findSavedImports(mk('0'.repeat(40)), text, added, 'h'))], []);
	assert.deepEqual([...(await findSavedImports(mk(null), text, added, 'h'))], []);
	asks.length = 0;
	assert.deepEqual([...(await findSavedImports(mk(await gitBlobSha(bytes)), JSON.stringify([canonicalEntry('chair', 'Other', 1)]), added, 'h'))], [], 'different label');
	assert.deepEqual([...(await findSavedImports(mk(await gitBlobSha(bytes)), JSON.stringify([canonicalEntry('chair', 'Chair', 2)]), added, 'h'))], [], 'different scale');
	assert.deepEqual([...(await findSavedImports(mk(await gitBlobSha(bytes)), '[]', added, 'h'))], [], 'not listed');
	assert.deepEqual(asks, [], 'no request unless the entry is identical');
	for (const bad of ['not json', '', '{"id":"chair"}', 'null']) assert.deepEqual([...(await findSavedImports(mk('x'), bad, added, 'h'))], [], JSON.stringify(bad));
});

test('findSavedImports: verifies each import on its own (one saved, one not, one with other bytes)', async () => {
	const a = canonicalEntry('a', 'A', 1), b = canonicalEntry('b', 'B', 1), c = canonicalEntry('c', 'C', 1);
	const bytesA = Uint8Array.from([1]), bytesB = Uint8Array.from([2]), bytesC = Uint8Array.from([3]);
	const shas: Record<string, string> = { 'public/models/a.glb': await gitBlobSha(bytesA), 'public/models/c.glb': await gitBlobSha(Uint8Array.from([99])) };
	const github = { getBlobSha: async (path: string) => shas[path] ?? null };
	const saved = await findSavedImports(github, JSON.stringify([a, c]), [{ entry: a, bytes: bytesA }, { entry: b, bytes: bytesB }, { entry: c, bytes: bytesC }], 'h');
	assert.deepEqual([...saved], ['a']);
});

test('findSavedImports: a getBlobSha error propagates (a failed check is not "not saved")', async () => {
	const e = canonicalEntry('chair', 'Chair', 1);
	await assert.rejects(
		() => findSavedImports({ getBlobSha: async () => { throw new GithubError('server', 'down', 500); } }, JSON.stringify([e]), [{ entry: e, bytes: GLB }], 'h'),
		(err: unknown) => err instanceof GithubError && err.kind === 'server',
	);
});

// ---- through the real client -------------------------------------------------------------------------------------------

test('saveModels through the real client (M1): identical bytes -> only GETs, one contents lookup of the .glb at the head', async () => {
	const net = e2eFetch({ headSequence: ['H1'], models: modelsText(entry('chair', 'My chair', 0.5)), scene: sceneText(), glbShas: { 'public/models/chair.glb': await gitBlobSha(GLB) } });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	const r = await saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]) });
	assert.equal(r.commitSha, null);
	assert.ok(net.calls.every((c) => c.method === 'GET'));
	assert.equal(net.calls.filter((c) => c.url.includes('public/models/chair.glb?ref=H1')).length, 1);
});

test('saveModels through the real client (M1): different bytes under the same id -> rejected with the rename message and no write', async () => {
	const net = e2eFetch({ headSequence: ['H1'], models: modelsText(entry('chair', 'My chair', 0.5)), scene: sceneText(), glbShas: { 'public/models/chair.glb': '1'.repeat(40) } });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	await assert.rejects(() => saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]) }), (e: unknown) => e instanceof GithubError && e.kind === 'rejected' && /its file there is missing or not the same.*another name/.test(e.message));
	assert.ok(net.calls.every((c) => c.method === 'GET'));
});

test('saveModels through the real client (M1): identical entry, the .glb 404s -> rejected (not saved)', async () => {
	const net = e2eFetch({ headSequence: ['H1'], models: modelsText(entry('chair', 'My chair', 0.5)), scene: sceneText() });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	await assert.rejects(() => saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'chair', label: 'My chair', scale: 0.5 }]) }), (e: unknown) => e instanceof GithubError && e.kind === 'rejected');
});


test('saveModels through the real client (m3): the no-op save sends only GETs', async () => {
	const net = e2eFetch({ headSequence: ['H1'], models: modelsText(entry('a')), scene: sceneText() });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	const r = await saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([], ['ghost']) });
	assert.equal(r.commitSha, null);
	assert.ok(net.calls.every((c) => c.method === 'GET'), 'no blob, tree, commit or PATCH');
});

test('buildModelCommit (m4): an identical remote entry for one import + a different one for another still rejects the different one', () => {
	failsWith(() => build(modelsText(entry('a', 'a', 1), entry('b', 'Remote b')), sceneText(), pending([{ id: 'a' }, { id: 'b', label: 'Local b' }]), new Set(['a', 'b'])), 'rejected', /different model.*"b"/i);
});

// BUG-4: refusal message uses the remote label and room names.
test('buildModelCommit (BUG-4): the remote-use refusal names the model by label and rooms by name', () => {
	const scene = sceneText({ elnur: [obj('o1', 'model:chair')], fazil: [obj('o2', 'model:chair'), obj('o3', 'model:chair')] });
	const names = new Map([['elnur', "Elnur's room"], ['fazil', "Fazil's room"]]);
	failsWith(() => buildModelCommit({ remoteModelsText: modelsText(entry('chair', 'Comfy chair')), remoteSceneText: scene, slugs: SLUGS, pending: pending([], ['chair']), roomNames: names }), 'rejected', /"Comfy chair".*Elnur's room: 1, Fazil's room: 2/);
	// without names it falls back to the slug, without a remote label to the id
	failsWith(() => build(modelsText(entry('chair', 'Comfy chair')), scene, pending([], ['chair'])), 'rejected', /"Comfy chair".*elnur: 1, fazil: 2/);
});

test('saveModels (BUG-4): roomNames reach the refusal message', async () => {
	const f = fakeClient([{ head: 'H1', models: modelsText(entry('chair', 'Comfy')), scene: sceneText({ nadir: [obj('o1', 'model:chair')] }) }]);
	await assert.rejects(
		() => saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([], ['chair']), roomNames: new Map([['nadir', "Nadir's room"]]) }),
		(e: unknown) => e instanceof GithubError && /"Comfy".*Nadir's room: 1/.test(e.message),
	);
});

// BUG-1 (fixed in fix round 1): delete + re-import of one id must not list the .glb path twice.
test('buildModelCommit (BUG-1): re-adding an id that is also being removed in the same commit yields unique paths', () => {
	const c = build(modelsText(entry('chair', 'Old')), sceneText(), pending([{ id: 'chair', label: 'New' }], ['chair']));
	assert.equal(JSON.parse(c.modelsText).length, 1);
	assert.equal(JSON.parse(c.modelsText)[0].label, 'New');
	// the same path is both deleted and written: must not appear twice in one commit (commitFiles refuses duplicate paths)
	const paths = c.changes.map((x) => x.path);
	assert.equal(new Set(paths).size, paths.length, `duplicate path in ${JSON.stringify(paths)}`);
});

test('buildModelCommit: two pending imports with the same id are rejected (no duplicate entries/paths)', () => {
	failsWith(() => build('[]', sceneText(), pending([{ id: 'dup' }, { id: 'dup' }])), 'rejected');
});

// ---- saveModels: flow, retry, fail closed ---------------------------------------------------------------

interface FakeState { head: string; models: string; scene: string; /** git blob sha per repo path as of this head; a missing path is a missing file */ blobs?: Record<string, string> }
function fakeClient(states: FakeState[], opts: { commit?: (n: number, a: { message: string; changes: readonly FileChange[]; expectedHead?: string }) => Promise<{ commitSha: string }> } = {}) {
	const log: string[] = [];
	let i = 0;
	let commits = 0;
	const current = () => states[Math.min(i, states.length - 1)];
	const github: Pick<GithubClient, 'getHead' | 'getFileAt' | 'getBlobSha' | 'commitFiles'> = {
		async getHead() {
			log.push('getHead');
			return current().head;
		},
		async getFileAt(path, ref) {
			log.push(`getFileAt ${path}@${ref}`);
			assert.equal(ref, current().head, 'files are read at the head that was just read');
			return { text: path === MODELS_JSON_PATH ? current().models : current().scene, sha: 's' };
		},
		async getBlobSha(path, ref) {
			log.push(`getBlobSha ${path}@${ref}`);
			assert.equal(ref, current().head, 'the blob is looked up at the head that was just read');
			return current().blobs?.[path] ?? null;
		},
		async commitFiles(args) {
			log.push(`commitFiles expectedHead=${args.expectedHead}`);
			commits++;
			if (opts.commit) {
				try {
					return await opts.commit(commits, args);
				} finally {
					i++;
				}
			}
			return { commitSha: 'done' };
		},
	};
	return { github, log, commitCount: () => commits };
}

test('saveModels: reads head, models.json and scene.json at that head, then commits with expectedHead', async () => {
	const f = fakeClient([{ head: 'H1', models: '[]', scene: sceneText() }]);
	const r = await saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'a' }]) });
	assert.deepEqual(f.log, ['getHead', `getFileAt ${MODELS_JSON_PATH}@H1`, `getFileAt ${SCENE_PATH}@H1`, 'commitFiles expectedHead=H1']);
	assert.deepEqual(r, { commitSha: 'done', added: 1, removed: 0 });
});

test('saveModels: conflict -> retries ONCE from the new head and merges into the NEW remote list', async () => {
	let sent: Array<{ expectedHead?: string; models: string }> = [];
	const f = fakeClient(
		[
			{ head: 'H1', models: '[]', scene: sceneText() },
			{ head: 'H2', models: modelsText(entry('someone-elses')), scene: sceneText() },
		],
		{
			commit: async (n, a) => {
				sent.push({ expectedHead: a.expectedHead, models: (a.changes.find((c) => c.path === MODELS_JSON_PATH) as { text: string }).text });
				if (n === 1) throw new GithubError('conflict', 'moved', 422);
				return { commitSha: 'second' };
			},
		},
	);
	const r = await saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'mine' }]) });
	assert.equal(r.commitSha, 'second');
	assert.equal(f.commitCount(), 2);
	assert.deepEqual(sent.map((s) => s.expectedHead), ['H1', 'H2']);
	assert.deepEqual(JSON.parse(sent[0].models).map((m: { id: string }) => m.id), ['mine']);
	assert.deepEqual(JSON.parse(sent[1].models).map((m: { id: string }) => m.id), ['someone-elses', 'mine'], 'the other save is not lost');
	assert.equal(f.log.filter((l) => l === 'getHead').length, 2);
});

test('saveModels: a second conflict is reported (exactly two attempts, no endless loop)', async () => {
	const f = fakeClient([{ head: 'H1', models: '[]', scene: sceneText() }], { commit: async () => { throw new GithubError('conflict', 'moved again', 422); } });
	await assert.rejects(() => saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'a' }]) }), (e: unknown) => e instanceof GithubError && e.kind === 'conflict');
	assert.equal(f.commitCount(), 2);
});

test('saveModels: other errors are NOT retried (auth, server, network, rejected)', async () => {
	for (const kind of ['auth', 'server', 'network', 'rejected', 'timeout'] as const) {
		const f = fakeClient([{ head: 'H1', models: '[]', scene: sceneText() }], { commit: async () => { throw new GithubError(kind, 'x'); } });
		await assert.rejects(() => saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'a' }]) }), (e: unknown) => e instanceof GithubError && e.kind === kind);
		assert.equal(f.commitCount(), 1, kind);
	}
});

test('saveModels: a non-GithubError from the client propagates without a retry', async () => {
	const f = fakeClient([{ head: 'H1', models: '[]', scene: sceneText() }], { commit: async () => { throw new TypeError('boom'); } });
	await assert.rejects(() => saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'a' }]) }), TypeError);
	assert.equal(f.commitCount(), 1);
});

test('saveModels fails closed when the remote scene uses a to-be-deleted model: no commit is attempted', async () => {
	const f = fakeClient([{ head: 'H1', models: modelsText(entry('chair')), scene: sceneText({ nadir: [obj('o1', 'model:chair')] }) }]);
	await assert.rejects(() => saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([], ['chair']) }), (e: unknown) => e instanceof GithubError && e.kind === 'rejected' && /nadir: 1/.test(e.message));
	assert.equal(f.commitCount(), 0);
});

test('saveModels: after a conflict the scene at the NEW head is re-checked (a delete that became used is refused)', async () => {
	const f = fakeClient(
		[
			{ head: 'H1', models: modelsText(entry('chair')), scene: sceneText() },
			{ head: 'H2', models: modelsText(entry('chair')), scene: sceneText({ elnur: [obj('o1', 'model:chair')] }) },
		],
		{ commit: async (n) => { if (n === 1) throw new GithubError('conflict', 'moved', 422); return { commitSha: 'x' }; } },
	);
	await assert.rejects(() => saveModels({ github: f.github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([], ['chair']) }), (e: unknown) => e instanceof GithubError && e.kind === 'rejected');
	assert.equal(f.commitCount(), 1, 'the retry never reached commitFiles');
});

test('saveModels fails closed when the remote files cannot be read (reader errors propagate, nothing is committed)', async () => {
	let committed = 0;
	const github = {
		async getHead() { return 'H1'; },
		async getFileAt(path: string) {
			if (path === SCENE_PATH) throw new GithubError('not-found', 'no scene', 404);
			return { text: '[]', sha: 's' };
		},
		async commitFiles() { committed++; return { commitSha: 'x' }; },
	};
	await assert.rejects(() => saveModels({ github, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'a' }]) }), (e: unknown) => e instanceof GithubError && e.kind === 'not-found');
	assert.equal(committed, 0);
});

// ---- saveModels end-to-end through the real client (fake fetch) ------------------------------------------

function e2eFetch(opts: { headSequence: string[]; models: string; scene: string; patchFailures?: number; glbShas?: Record<string, string> }) {
	const calls: Array<{ method: string; url: string; body?: any }> = [];
	let headReads = 0;
	let patches = 0;
	const REPO = `${API_BASE}/repos/${DEFAULT_TARGET.owner}/${DEFAULT_TARGET.repo}`;
	const fetch = async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ method, url, body });
		const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
		if (url.includes('/git/ref/heads/')) return ok({ object: { sha: opts.headSequence[Math.min(headReads++, opts.headSequence.length - 1)] } });
		if (url.includes('/git/commits/')) return ok({ tree: { sha: 'tree0' } });
		if (url.includes('/contents/')) {
			const path = decodeURIComponent(url.slice(`${REPO}/contents/`.length).split('?')[0]);
			if (opts.glbShas && path in opts.glbShas) return ok({ type: 'file', encoding: 'none', sha: opts.glbShas[path], size: 2000, content: '' });
			if (path !== MODELS_JSON_PATH && path !== SCENE_PATH) return ok({ message: 'Not Found' }, 404);
			return ok({ type: 'file', encoding: 'base64', sha: 'fs', content: Buffer.from(path === MODELS_JSON_PATH ? opts.models : opts.scene).toString('base64') });
		}
		if (url.endsWith('/git/blobs')) return ok({ sha: `blob${calls.length}` }, 201);
		if (url.endsWith('/git/trees')) return ok({ sha: 'tree1' }, 201);
		if (method === 'POST' && url.endsWith('/git/commits')) return ok({ sha: `commit${calls.length}` }, 201);
		if (method === 'PATCH') {
			if (patches++ < (opts.patchFailures ?? 0)) return ok({ message: 'Update is not a fast forward' }, 422);
			return ok({});
		}
		return ok({ message: 'unexpected' }, 404);
	};
	return { fetch, calls };
}

test('saveModels through the real client: one atomic commit with the glb, deletion and models.json in ONE tree', async () => {
	const net = e2eFetch({ headSequence: ['H1'], models: modelsText(entry('old')), scene: sceneText() });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	const r = await saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'fresh', label: 'Fresh', scale: 0.25 }], ['old']) });
	assert.equal(r.added, 1);
	assert.equal(r.removed, 1);
	const tree = net.calls.find((c) => c.url.endsWith('/git/trees'))!.body;
	assert.deepEqual(tree.tree.map((t: { path: string; sha: unknown }) => [t.path, t.sha === null]), [
		['public/models/old.glb', true],
		['public/models/fresh.glb', false],
		['src/data/models.json', false],
	]);
	assert.equal(net.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/git/commits')).length, 1, 'exactly one commit');
	assert.equal(net.calls.filter((c) => c.method === 'PATCH').length, 1);
	const modelsBlob = net.calls.filter((c) => c.url.endsWith('/git/blobs'))[1].body;
	assert.equal(Buffer.from(modelsBlob.content, 'base64').toString('utf8'), serializeModels([entry('fresh', 'Fresh', 0.25)]));
	const glbBlob = net.calls.find((c) => c.url.endsWith('/git/blobs'))!.body;
	assert.deepEqual(Uint8Array.from(Buffer.from(glbBlob.content, 'base64')), GLB, 'the committed bytes are exactly the imported GLB');
});

test('saveModels through the real client: ref PATCH 422 not-a-fast-forward -> ONE retry from the new head -> success', async () => {
	const net = e2eFetch({ headSequence: ['H1', 'H1', 'H2', 'H2'], models: '[]', scene: sceneText(), patchFailures: 1 });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	const r = await saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'a' }]) });
	assert.equal(r.added, 1);
	assert.equal(net.calls.filter((c) => c.method === 'PATCH').length, 2);
	const parents = net.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/git/commits')).map((c) => c.body.parents[0]);
	assert.deepEqual(parents, ['H1', 'H2'], 'second commit is built on the new head');
});

test('saveModels through the real client: two 422s -> conflict is reported after exactly two commit attempts', async () => {
	const net = e2eFetch({ headSequence: ['H1', 'H1', 'H2', 'H2'], models: '[]', scene: sceneText(), patchFailures: 5 });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	await assert.rejects(() => saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'a' }]) }), (e: unknown) => e instanceof GithubError && e.kind === 'conflict');
	assert.equal(net.calls.filter((c) => c.method === 'PATCH').length, 2);
});

test('saveModels through the real client: remote scene read error / unusable scene -> nothing written (no blob/tree/commit/PATCH)', async () => {
	const net = e2eFetch({ headSequence: ['H1'], models: '[]', scene: '{ not json' });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	await assert.rejects(() => saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'a' }]) }), (e: unknown) => e instanceof GithubError && e.kind === 'bad-response');
	assert.ok(!net.calls.some((c) => c.method !== 'GET'), 'only GETs were sent');
});

test('buildModelCommit (BUG-1): delete + re-add keeps the WRITE (bytes), drops the delete, counts +1 and -1', () => {
	const c = build(modelsText(entry('chair', 'Old')), sceneText(), pending([{ id: 'chair', label: 'New' }], ['chair']));
	const glb = c.changes.filter((x) => x.path === 'public/models/chair.glb');
	assert.equal(glb.length, 1);
	assert.ok('bytes' in glb[0], 'the surviving change is the write, not the delete');
	assert.equal(c.added, 1);
	assert.equal(c.removed, 1);
	assert.equal(c.message, 'admin: update model library (+1, −1)');
});

test('saveModels through the real client (BUG-1): delete + re-add commits (no invalid-config) with one blob per file and no sha:null for the re-added path', async () => {
	const net = e2eFetch({ headSequence: ['H1'], models: modelsText(entry('chair', 'Old')), scene: sceneText() });
	const gh = createGithubClient({ token: 'test-token-not-real', target: DEFAULT_TARGET, fetch: net.fetch });
	const r = await saveModels({ github: gh, scenePath: SCENE_PATH, slugs: SLUGS, pending: pending([{ id: 'chair', label: 'New' }], ['chair']) });
	assert.ok(r.commitSha);
	const tree = net.calls.find((c) => c.url.endsWith('/git/trees'))!.body.tree as Array<{ path: string; sha: unknown }>;
	assert.deepEqual(tree.map((t) => [t.path, t.sha === null]), [['public/models/chair.glb', false], ['src/data/models.json', false]]);
});
