// Task local-folder, core: how dev/local-save-core.mjs creates and guards `local/` (local/scene.json, local/models.json,
// local/models/<id>.glb): creation of what is missing, never overwriting what exists, refusing a symlinked / outside /
// non-directory local/ and local/models (nothing read, nothing written, nothing created outside the repo), the wire ->
// disk path mapping, `readRaw` (module loader), `openGlb` (the /models route), `differs` (banner), and that the committed
// src/data/*.json + public/models/* are never touched. Temp repo roots: tests/.tmp-local-folder-core-*, removed in after().
// Run: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	LocalSaveError, createLocalSave, diskRel, gitBlobSha, classifyPath,
	SCENE_PATH, MODELS_PATH, MODELS_DIR, LOCAL_DIR, LOCAL_SCENE, LOCAL_MODELS, LOCAL_MODELS_DIR,
} from '../dev/local-save-core.mjs';
import { emptyScene, parseModels, parseScene, serializeScene, validateScene } from '../src/data/scene.ts';
import { makeBoxGlb } from './helpers/gltf-fixtures.ts';
import { COMMITTED_MODELS, COMMITTED_SCENE, SLUGS, listLocal, modelsJsonText, seedRepo, sceneWithObject, snapshotCommitted, toDisk } from './helpers/local-repo.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB = makeBoxGlb();
const EMPTY_SCENE_TEXT = serializeScene(emptyScene([]));

let tmpBase = '';
let n = 0;
before(async () => {
	tmpBase = await mkdtemp(path.join(HERE, '.tmp-local-folder-core-'));
});
after(async () => {
	if (tmpBase) await rm(tmpBase, { recursive: true, force: true });
});

const rejects = (promise: Promise<unknown>, status: number, kind: string) =>
	assert.rejects(promise, (e: unknown) => e instanceof LocalSaveError && e.status === status && e.kind === kind, `expected LocalSaveError ${status} ${kind}`);
const exists = (p: string) => lstat(p).then(() => true, () => false);

/** A bare temp "repo": optional canaries and local/ pieces, plus a store on it. */
async function makeRoot(opts: Parameters<typeof seedRepo>[1] & { bare?: boolean } = {}) {
	const root = path.join(tmpBase, `repo${n++}`);
	if (opts.bare) await mkdir(root, { recursive: true });
	else await seedRepo(root, opts);
	const touched: string[] = [];
	const store = createLocalSave({ root, slugs: SLUGS, onWrite: (abs: string) => touched.push(abs) });
	return { root, store, touched, abs: (rel: string) => path.join(root, rel) };
}
/** Everything below `dir` (relative, sorted), directories with a trailing slash. */
async function tree(dir: string, prefix = ''): Promise<string[]> {
	const out: string[] = [];
	for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const rel = `${prefix}${entry.name}`;
		if (entry.isDirectory()) out.push(`${rel}/`, ...(await tree(path.join(dir, entry.name), `${rel}/`)));
		else out.push(rel);
	}
	return out;
}

// ---- wire -> disk mapping ---------------------------------------------------------------------------------------

test('diskRel: the three wire paths map onto local/; anything else is a 403 (no mapping for committed-only names)', () => {
	assert.equal(diskRel(SCENE_PATH), 'local/scene.json');
	assert.equal(diskRel(MODELS_PATH), 'local/models.json');
	assert.equal(diskRel(`${MODELS_DIR}/chair.glb`), 'local/models/chair.glb');
	assert.equal(diskRel('public/models/Tall_House-9.glb'), 'local/models/Tall_House-9.glb');
	assert.deepEqual([LOCAL_DIR, LOCAL_SCENE, LOCAL_MODELS, LOCAL_MODELS_DIR], ['local', 'local/scene.json', 'local/models.json', 'local/models']);
	for (const bad of ['package.json', 'src/data/family.ts', 'local/scene.json', 'local/models/a.glb', 'public/models/a/b.glb', 'public/models/../x.glb', '../src/data/scene.json', '', 'public/models/a.gltf', 'public/models/a.GLB']) {
		assert.throws(() => diskRel(bad), (e: unknown) => e instanceof LocalSaveError && e.status === 403, JSON.stringify(bad));
	}
	// the helper used by the tests agrees with the core
	for (const wire of [SCENE_PATH, MODELS_PATH, 'public/models/x.glb']) assert.equal(toDisk(wire), diskRel(wire));
});

test('the allowlist is still keyed on the WIRE paths: a local/ path is not accepted from a client', () => {
	assert.ok(classifyPath(SCENE_PATH) && classifyPath(MODELS_PATH) && classifyPath('public/models/a.glb'));
	for (const p of ['local/scene.json', 'local/models.json', 'local/models/a.glb', './local/scene.json', '/local/scene.json']) assert.equal(classifyPath(p), null, p);
});

// ---- creation -----------------------------------------------------------------------------------------------------

test('ensureLocal: from nothing creates local/, local/models/, an empty valid scene and `[]`, and reports exactly what it created', async () => {
	const { root, store, abs } = await makeRoot({ bare: true });
	const created = await store.ensureLocal();
	assert.deepEqual(created, ['local/', 'local/models/', 'local/scene.json', 'local/models.json']);
	assert.deepEqual(await tree(root), ['local/', 'local/models/', 'local/models.json', 'local/scene.json'], 'nothing else, no temp files, no src/ or public/');
	assert.equal(await readFile(abs('local/scene.json'), 'utf8'), EMPTY_SCENE_TEXT);
	assert.equal(await readFile(abs('local/models.json'), 'utf8'), '[]\n');
	assert.equal((await stat(abs('local/models'))).isDirectory(), true);
	for (const f of ['local/scene.json', 'local/models.json']) assert.equal(((await stat(abs(f))).mode & 0o022), 0, `${f} is not group/world writable`);
});

test('the empty scene passes validateScene / parseScene (with and without slugs, with an empty model list) and models.json parses to no models', async () => {
	const { store, abs } = await makeRoot({ bare: true });
	await store.ensureLocal();
	const scene = JSON.parse(await readFile(abs('local/scene.json'), 'utf8'));
	assert.deepEqual(scene, { version: 1, rooms: {} });
	assert.deepEqual(validateScene(scene, { slugs: SLUGS }), []);
	assert.deepEqual(validateScene(scene, { slugs: SLUGS, modelIds: [] }), []);
	assert.deepEqual(validateScene(scene), []);
	const parsed = parseScene(scene, { slugs: SLUGS, modelIds: [] });
	assert.equal(parsed.ok, true);
	assert.deepEqual(Object.keys(parsed.scene.rooms).sort(), [...SLUGS].sort(), 'every room exists (empty) after parsing');
	assert.ok(Object.values(parsed.scene.rooms).every((room) => room.objects.length === 0));
	const models = JSON.parse(await readFile(abs('local/models.json'), 'utf8'));
	assert.deepEqual(models, []);
	assert.equal(parseModels(models).length, 0);
	// and the store itself serves both through the normal read path (no 404, no validation problem)
	assert.equal((await store.readText(SCENE_PATH)).text, EMPTY_SCENE_TEXT);
	assert.equal((await store.readText(MODELS_PATH)).text, '[]\n');
});

test('ensureLocal is idempotent: a second call creates nothing and does not rewrite (same inode and mtime)', async () => {
	const { store, abs, touched } = await makeRoot({ bare: true });
	await store.ensureLocal();
	const before = await Promise.all(['local/scene.json', 'local/models.json'].map(async (f) => { const s = await stat(abs(f)); return [s.ino, s.mtimeMs]; }));
	touched.length = 0;
	assert.deepEqual(await store.ensureLocal(), []);
	assert.deepEqual(touched, [], 'no write was announced');
	const after = await Promise.all(['local/scene.json', 'local/models.json'].map(async (f) => { const s = await stat(abs(f)); return [s.ino, s.mtimeMs]; }));
	assert.deepEqual(after, before);
});

test('ensureLocal: existing files are NEVER overwritten (any content, valid or not), even next to missing pieces', async () => {
	const hand = sceneWithObject('hand', 'lamp');
	const handModels = modelsJsonText('mine');
	const garbage = '{ this is not json';
	// 1. both files exist with real content, directories missing models/
	{
		const { root, store, abs } = await makeRoot({ bare: true });
		await mkdir(abs('local'));
		await writeFile(abs('local/scene.json'), hand);
		await writeFile(abs('local/models.json'), handModels);
		assert.deepEqual(await store.ensureLocal(), ['local/models/']);
		assert.equal(await readFile(abs('local/scene.json'), 'utf8'), hand);
		assert.equal(await readFile(abs('local/models.json'), 'utf8'), handModels);
		assert.deepEqual((await listLocal(root)).top, ['models', 'models.json', 'scene.json']);
	}
	// 2. a hand-broken scene and an EMPTY models.json are left exactly as they are (the user fixes them, we never "repair")
	{
		const { store, abs } = await makeRoot({ bare: true });
		await mkdir(abs('local/models'), { recursive: true });
		await writeFile(abs('local/scene.json'), garbage);
		await writeFile(abs('local/models.json'), '');
		assert.deepEqual(await store.ensureLocal(), []);
		assert.equal(await readFile(abs('local/scene.json'), 'utf8'), garbage);
		assert.equal(await readFile(abs('local/models.json'), 'utf8'), '');
	}
	// 3. models in local/models survive, other files in local/ survive
	{
		const { store, abs } = await makeRoot({ bare: true });
		await mkdir(abs('local/models'), { recursive: true });
		await writeFile(abs('local/models/keep.glb'), GLB);
		await writeFile(abs('local/notes.txt'), 'mine');
		assert.deepEqual(await store.ensureLocal(), ['local/scene.json', 'local/models.json']);
		assert.deepEqual(await readFile(abs('local/models/keep.glb')), Buffer.from(GLB));
		assert.equal(await readFile(abs('local/notes.txt'), 'utf8'), 'mine');
	}
});

test('ensureLocal: partial states are completed piecewise (only local/, only scene.json, only models.json, only models/)', async () => {
	const cases: Array<[string, (abs: (r: string) => string) => Promise<void>, string[]]> = [
		['only local/', async (abs) => { await mkdir(abs('local')); }, ['local/models/', 'local/scene.json', 'local/models.json']],
		['only local/models/', async (abs) => { await mkdir(abs('local/models'), { recursive: true }); }, ['local/scene.json', 'local/models.json']],
		['only scene.json', async (abs) => { await mkdir(abs('local')); await writeFile(abs('local/scene.json'), EMPTY_SCENE_TEXT); }, ['local/models/', 'local/models.json']],
		['only models.json', async (abs) => { await mkdir(abs('local')); await writeFile(abs('local/models.json'), '[]\n'); }, ['local/models/', 'local/scene.json']],
	];
	for (const [name, setup, expected] of cases) {
		const { root, store, abs } = await makeRoot({ bare: true });
		await setup(abs);
		assert.deepEqual(await store.ensureLocal(), expected, name);
		assert.deepEqual(await tree(root), ['local/', 'local/models/', 'local/models.json', 'local/scene.json'], name);
	}
});

test('ensureLocal: concurrent callers share one run (one set of files, identical result, no temp leftovers)', async () => {
	const { root, store } = await makeRoot({ bare: true });
	const results = await Promise.all(Array.from({ length: 8 }, () => store.ensureLocal()));
	assert.deepEqual(results[0], ['local/', 'local/models/', 'local/scene.json', 'local/models.json']);
	for (const r of results) assert.deepEqual(r, results[0]);
	assert.deepEqual(await tree(root), ['local/', 'local/models/', 'local/models.json', 'local/scene.json']);
	// two separate stores on the same root racing: both succeed, files created once, content intact
	const root2 = path.join(tmpBase, `repo${n++}`);
	await mkdir(root2);
	const a = createLocalSave({ root: root2, slugs: SLUGS });
	const b = createLocalSave({ root: root2, slugs: SLUGS });
	await Promise.all([a.ensureLocal(), b.ensureLocal(), a.ensureLocal(), b.ensureLocal()]);
	assert.deepEqual(await tree(root2), ['local/', 'local/models/', 'local/models.json', 'local/scene.json']);
	assert.equal(await readFile(path.join(root2, 'local/scene.json'), 'utf8'), EMPTY_SCENE_TEXT);
});

test('ensureLocal: creation is announced to onWrite (so the dev server treats it as its own write)', async () => {
	const { store, touched, abs } = await makeRoot({ bare: true });
	await store.ensureLocal();
	assert.ok(touched.includes(abs('local/scene.json')) && touched.includes(abs('local/models.json')));
	assert.ok(touched.some((p) => p.endsWith('.tmp')), 'the temp file is announced too');
});

test('ensureLocal does not touch the committed files and does not create src/ or public/ in a checkout that lacks them', async () => {
	const { root, store } = await makeRoot();
	const baseline = await snapshotCommitted(root);
	await rm(path.join(root, 'local'), { recursive: true, force: true });
	await store.ensureLocal();
	assert.deepEqual(await snapshotCommitted(root), baseline);
	const bare = await makeRoot({ bare: true });
	await bare.store.ensureLocal();
	assert.equal(await exists(path.join(bare.root, 'src')), false);
	assert.equal(await exists(path.join(bare.root, 'public')), false);
});

test('local/ deleted while the store lives is re-created by the next read / head / write', async () => {
	for (const op of ['readText', 'head', 'blobSha', 'writeFile', 'differs', 'readRaw', 'openGlb'] as const) {
		const { root, store, abs } = await makeRoot();
		await rm(path.join(root, 'local'), { recursive: true });
		if (op === 'readText') assert.equal((await store.readText(SCENE_PATH)).text, EMPTY_SCENE_TEXT);
		if (op === 'head') assert.match((await store.head()).head, /^[0-9a-f]{40}$/);
		if (op === 'blobSha') assert.equal((await store.blobSha(SCENE_PATH)).sha, gitBlobSha(Buffer.from(EMPTY_SCENE_TEXT)));
		if (op === 'writeFile') {
			const res = await store.writeFile(SCENE_PATH, Buffer.from(sceneWithObject('a')), gitBlobSha(Buffer.from(EMPTY_SCENE_TEXT)));
			assert.equal(res.sha, gitBlobSha(Buffer.from(sceneWithObject('a'))));
		}
		if (op === 'differs') assert.equal(await store.differs(), true);
		if (op === 'readRaw') assert.equal((await store.readRaw('scene')).text, EMPTY_SCENE_TEXT);
		if (op === 'openGlb') assert.equal(await store.openGlb('nothing'), null);
		assert.equal(await exists(abs('local/models.json')), true, op);
		assert.equal((await stat(abs('local/models'))).isDirectory(), true, op);
	}
});

// ---- refusals: symlinks, outside the repo, wrong types -------------------------------------------------------------

type Refusal = { name: string; setup: (ctx: { root: string; outside: string; abs: (r: string) => string }) => Promise<void> };
const REFUSALS: Refusal[] = [
	{ name: 'local is a symlink to a directory OUTSIDE the repo', setup: async ({ outside, abs }) => { await symlink(outside, abs('local')); } },
	{ name: 'local is a symlink to a directory INSIDE the repo', setup: async ({ abs }) => { await mkdir(abs('elsewhere/models'), { recursive: true }); await symlink(abs('elsewhere'), abs('local')); } },
	{ name: 'local is a dangling symlink', setup: async ({ abs }) => { await symlink(abs('does-not-exist'), abs('local')); } },
	{ name: 'local is a regular file', setup: async ({ abs }) => { await writeFile(abs('local'), 'x'); } },
	{ name: 'local/models is a symlink to a directory outside the repo', setup: async ({ outside, abs }) => { await mkdir(abs('local')); await symlink(outside, abs('local/models')); } },
	{ name: 'local/models is a symlink to a sibling directory inside the repo', setup: async ({ abs }) => { await mkdir(abs('local')); await mkdir(abs('public/other'), { recursive: true }); await symlink(abs('public/other'), abs('local/models')); } },
	{ name: 'local/models is a regular file', setup: async ({ abs }) => { await mkdir(abs('local')); await writeFile(abs('local/models'), 'x'); } },
	{ name: 'local/scene.json is a symlink to a file outside the repo', setup: async ({ outside, abs }) => { await mkdir(abs('local/models'), { recursive: true }); await writeFile(path.join(outside, 'f.json'), 'SECRET'); await symlink(path.join(outside, 'f.json'), abs('local/scene.json')); } },
	{ name: 'local/models.json is a dangling symlink', setup: async ({ abs }) => { await mkdir(abs('local/models'), { recursive: true }); await symlink(abs('nope.json'), abs('local/models.json')); } },
	{ name: 'local/scene.json is a directory', setup: async ({ abs }) => { await mkdir(abs('local/models'), { recursive: true }); await mkdir(abs('local/scene.json')); } },
];

test('ensureLocal refuses (403) a symlinked / outside / wrong-type local/, local/models and data files — and creates nothing outside the repo', async () => {
	for (const refusal of REFUSALS) {
		const { root, store, abs } = await makeRoot({ bare: true });
		const outside = path.join(tmpBase, `outside${n++}`);
		await mkdir(outside);
		await refusal.setup({ root, outside, abs });
		await rejects(store.ensureLocal(), 403, 'forbidden');
		assert.deepEqual(await readdir(outside), refusal.name.includes('scene.json is a symlink') ? ['f.json'] : [], `${refusal.name}: nothing created outside the repo`);
		if (refusal.name.includes('scene.json is a symlink')) assert.equal(await readFile(path.join(outside, 'f.json'), 'utf8'), 'SECRET', 'the link target is unchanged');
		assert.equal(await exists(abs('nope.json')), false, `${refusal.name}: a dangling target is never created`);
		assert.equal(await exists(abs('does-not-exist')), false);
		assert.equal(await exists(abs('elsewhere/scene.json')), false);
		assert.equal(await exists(abs('public/other/scene.json')), false);
	}
});

test('every public operation refuses (and writes nothing) when local/ is unsafe: read, blob-sha, head, write, commit, raw, glb, differs', async () => {
	for (const refusal of REFUSALS) {
		const { root, store, abs } = await makeRoot({ bare: true });
		const outside = path.join(tmpBase, `outside${n++}`);
		await mkdir(outside);
		await refusal.setup({ root, outside, abs });
		const outsideBefore = await readdir(outside);
		const ops: Array<[string, () => Promise<unknown>]> = [
			['readText', () => store.readText(SCENE_PATH)],
			['readText models', () => store.readText(MODELS_PATH)],
			['blobSha', () => store.blobSha('public/models/a.glb')],
			['head', () => store.head()],
			['limits', () => store.limits()],
			['writeFile scene', () => store.writeFile(SCENE_PATH, Buffer.from(EMPTY_SCENE_TEXT), null)],
			['writeFile glb', () => store.writeFile('public/models/a.glb', GLB, null)],
			['readRaw scene', () => store.readRaw('scene')],
			['readRaw models', () => store.readRaw('models')],
			['openGlb', () => store.openGlb('a')],
			['differs', () => store.differs()],
		];
		for (const [name, run] of ops) await rejects(run(), 403, 'forbidden').catch((e) => { throw new Error(`${refusal.name} / ${name}: ${(e as Error).message}`); });
		assert.deepEqual(await readdir(outside), outsideBefore, `${refusal.name}: outside dir unchanged`);
		assert.deepEqual(await store.sweepStaleTemp(), [], `${refusal.name}: the sweep does nothing`);
	}
});

test('a symlinked repository ROOT is fine (local/ resolves inside the real root)', async () => {
	const real = path.join(tmpBase, `real${n++}`);
	await mkdir(real);
	const linkRoot = path.join(tmpBase, `link${n++}`);
	await symlink(real, linkRoot);
	const store = createLocalSave({ root: linkRoot, slugs: SLUGS });
	assert.deepEqual(await store.ensureLocal(), ['local/', 'local/models/', 'local/scene.json', 'local/models.json']);
	assert.equal(await readFile(path.join(real, 'local/models.json'), 'utf8'), '[]\n');
});

test('an unsafe local/ file in the middle of a run: a symlinked glb is a 403 for read / write / openGlb, and its target is never opened for writing', async () => {
	const { root, store, abs } = await makeRoot();
	const outside = path.join(tmpBase, `outside${n++}`);
	await mkdir(outside);
	await writeFile(path.join(outside, 'secret.glb'), 'SECRET');
	await symlink(path.join(outside, 'secret.glb'), abs('local/models/trap.glb'));
	await symlink(abs('missing.glb'), abs('local/models/dangling.glb'));
	await mkdir(abs('local/models/dir.glb'));
	for (const id of ['trap', 'dangling', 'dir']) {
		await rejects(store.blobSha(`public/models/${id}.glb`), 403, 'forbidden');
		await rejects(store.writeFile(`public/models/${id}.glb`, GLB, null), 403, 'forbidden');
		await rejects(store.openGlb(id), 403, 'forbidden');
	}
	// a FIFO swapped in for a model must not block the open (O_NONBLOCK) — it is refused as "not a regular file"
	execFileSync('mkfifo', [abs('local/models/fifo.glb')]);
	await rejects(store.openGlb('fifo'), 403, 'forbidden');
	await rejects(store.blobSha('public/models/fifo.glb'), 403, 'forbidden');
	assert.equal(await readFile(path.join(outside, 'secret.glb'), 'utf8'), 'SECRET');
	assert.equal(await exists(abs('missing.glb')), false);
	// the symlinked / directory entries do not appear in the head, but the head still works
	assert.match((await store.head()).head, /^[0-9a-f]{40}$/);
	void root;
});

// ---- the committed files are never touched -------------------------------------------------------------------------

test('write, commit (write + delete), read and head never touch src/data/*.json or public/models/* — sha256 and directory listing unchanged', async () => {
	const { root, store } = await makeRoot({ glbs: ['old'], models: modelsJsonText('old'), scene: sceneWithObject('o1', 'box') });
	const baseline = await snapshotCommitted(root);
	const listing = async () => ({ data: (await readdir(path.join(root, 'src/data'))).sort(), models: (await readdir(path.join(root, 'public/models'))).sort() });
	const listingBefore = await listing();
	const frame = (head: string, changes: Array<{ path: string; op: 'write'; bytes: Uint8Array } | { path: string; op: 'delete' }>) => {
		const described = changes.map((c) => (c.op === 'delete' ? { path: c.path, op: 'delete' } : { path: c.path, op: 'write', size: c.bytes.byteLength }));
		const header = Buffer.from(JSON.stringify({ expectedHead: head, changes: described }));
		const len = Buffer.alloc(4);
		len.writeUInt32BE(header.byteLength, 0);
		return Buffer.concat([len, header, ...changes.flatMap((c) => (c.op === 'write' ? [Buffer.from(c.bytes)] : []))]);
	};
	const scene = await store.readText(SCENE_PATH);
	await store.writeFile(SCENE_PATH, Buffer.from(sceneWithObject('o2', 'lamp')), scene.sha);
	await store.writeFile('public/models/extra.glb', GLB, null);
	const { head } = await store.head();
	await store.commit(frame(head, [
		{ path: MODELS_PATH, op: 'write', bytes: Buffer.from(modelsJsonText('extra')) },
		{ path: 'public/models/new.glb', op: 'write', bytes: GLB },
		{ path: SCENE_PATH, op: 'write', bytes: Buffer.from(EMPTY_SCENE_TEXT) },
		{ path: 'public/models/old.glb', op: 'delete' },
	]));
	assert.deepEqual(await snapshotCommitted(root), baseline, 'sha256 of every committed file');
	assert.deepEqual(await listing(), listingBefore, 'no committed-side file was added or removed');
	assert.equal(await readFile(path.join(root, 'src/data/scene.json'), 'utf8'), COMMITTED_SCENE);
	assert.equal(await readFile(path.join(root, 'src/data/models.json'), 'utf8'), COMMITTED_MODELS);
	assert.deepEqual((await listLocal(root)).models, ['extra.glb', 'new.glb']);
});

test('deleting a model removes local/models/<id>.glb only: a committed glb of the same id stays, and the delete is still blocked while the LOCAL scene uses it', async () => {
	const { root, store, abs } = await makeRoot({ glbs: ['chair'], models: modelsJsonText('chair'), scene: sceneWithObject('o1', 'model:chair') });
	await writeFile(path.join(root, 'public/models/chair.glb'), GLB); // a committed glb with the same id
	const baseline = await snapshotCommitted(root);
	const frame = (head: string) => {
		const header = Buffer.from(JSON.stringify({ expectedHead: head, changes: [{ path: 'public/models/chair.glb', op: 'delete' }] }));
		const len = Buffer.alloc(4);
		len.writeUInt32BE(header.byteLength, 0);
		return Buffer.concat([len, header]);
	};
	await rejects(store.commit(frame((await store.head()).head)), 422, 'rejected');
	assert.equal(await exists(abs('local/models/chair.glb')), true, 'still used by the local scene: not deleted');
	await writeFile(abs('local/scene.json'), EMPTY_SCENE_TEXT);
	const res = await store.commit(frame((await store.head()).head));
	assert.deepEqual(res.deleted, ['public/models/chair.glb'], 'the response keeps the wire path');
	assert.equal(await exists(abs('local/models/chair.glb')), false);
	assert.deepEqual(await snapshotCommitted(root), baseline, 'the committed chair.glb is still there');
});

// ---- readRaw (module loader) -----------------------------------------------------------------------------------------

test('readRaw: returns the text and absolute path of local/scene.json / local/models.json (never the committed twin), creating local/ first', async () => {
	const { root, store, abs } = await makeRoot({ bare: true });
	const s = await store.readRaw('scene');
	assert.equal(s.text, EMPTY_SCENE_TEXT);
	assert.equal(s.abs, path.join(root, 'local/scene.json'));
	const m = await store.readRaw('models');
	assert.equal(m.text, '[]\n');
	assert.equal(m.abs, path.join(root, 'local/models.json'));
	await writeFile(abs('local/scene.json'), COMMITTED_SCENE.replace('COMMITTED_CANARY', 'LOCAL_EDIT'));
	assert.match((await store.readRaw('scene')).text, /LOCAL_EDIT/, 'follows hand edits');
	// hand-broken files are returned as is (the page-side loader reports them); no validators are involved
	await writeFile(abs('local/scene.json'), '{ nope');
	assert.equal((await store.readRaw('scene')).text, '{ nope');
});

test('readRaw works while the validators cannot load (the module graph needs it before the rules exist)', async () => {
	const root = path.join(tmpBase, `repo${n++}`);
	await seedRepo(root, {});
	const store = createLocalSave({ root, slugs: SLUGS, validators: async () => { throw new Error('rules not loadable yet'); } });
	assert.equal((await store.readRaw('models')).text, '[]\n');
	await rejects(store.readText(SCENE_PATH), 500, 'internal');
});

// ---- openGlb ---------------------------------------------------------------------------------------------------------------

test('openGlb: opens local/models/<id>.glb only — the bytes and size are right, ids are validated, committed-only models are null', async () => {
	const { root, store } = await makeRoot({ glbs: ['chair'] });
	await writeFile(path.join(root, 'public/models/only-committed.glb'), GLB);
	const opened = await store.openGlb('chair');
	assert.ok(opened);
	try {
		assert.equal(opened.size, GLB.byteLength);
		const { buffer, bytesRead } = await opened.handle.read(Buffer.alloc(opened.size), 0, opened.size, 0);
		assert.deepEqual(buffer.subarray(0, bytesRead), Buffer.from(GLB));
	} finally {
		await opened.handle.close();
	}
	assert.equal(await store.openGlb('only-committed'), null, 'a model that exists only in public/models is invisible');
	assert.equal(await store.openGlb('committed-canary'), null);
	assert.equal(await store.openGlb('missing'), null);
	for (const bad of ['', '..', '../chair', 'a/b', 'a\\b', 'a.b', 'chair.glb', 'a b', 'x'.repeat(65), '%2e%2e', 'chair\0', 'CHAIR']) {
		assert.equal(await store.openGlb(bad), null, JSON.stringify(bad));
	}
	for (const bad of [undefined, null, 5, {}, ['chair']]) assert.equal(await store.openGlb(bad as never), null);
	// a zero-byte file opens with size 0 (the route answers it with an empty 200)
	await writeFile(path.join(root, 'local/models/empty.glb'), '');
	const empty = await store.openGlb('empty');
	assert.equal(empty?.size, 0);
	await empty?.handle.close();
});

// ---- differs (banner) --------------------------------------------------------------------------------------------------------

test('differs: true when local/scene.json OR local/models.json differs from the committed twin, false only when both are byte-identical', async () => {
	const { root, store, abs } = await makeRoot();
	assert.equal(await store.differs(), true, 'seed: both differ');
	const copy = async (name: 'scene' | 'models') => writeFile(abs(`local/${name}.json`), await readFile(path.join(root, `src/data/${name}.json`)));
	await copy('scene');
	assert.equal(await store.differs(), true, 'models still differ');
	await copy('models');
	assert.equal(await store.differs(), false, 'both identical');
	await writeFile(abs('local/scene.json'), `${COMMITTED_SCENE}\n`);
	assert.equal(await store.differs(), true, 'a single extra byte counts');
	await copy('scene');
	await writeFile(abs('local/models.json'), `${COMMITTED_MODELS} `);
	assert.equal(await store.differs(), true, 'models differ alone');
	await copy('models');
	assert.equal(await store.differs(), false);
	// glbs are not part of the flag
	await writeFile(abs('local/models/zzz.glb'), GLB);
	assert.equal(await store.differs(), false);
});

test('differs: a fresh (auto-created) local/ equals a committed empty scene + `[]`, and is "different" when the committed twin is missing, a directory or a symlink', async () => {
	const cases: Array<[string, (root: string) => Promise<void>, boolean]> = [
		['committed is the empty scene and []', async (root) => { await mkdir(path.join(root, 'src/data'), { recursive: true }); await writeFile(path.join(root, 'src/data/scene.json'), EMPTY_SCENE_TEXT); await writeFile(path.join(root, 'src/data/models.json'), '[]\n'); }, false],
		['no committed files', async () => {}, true],
		['committed scene.json missing', async (root) => { await mkdir(path.join(root, 'src/data'), { recursive: true }); await writeFile(path.join(root, 'src/data/models.json'), '[]\n'); }, true],
		['committed scene.json is a directory', async (root) => { await mkdir(path.join(root, 'src/data/scene.json'), { recursive: true }); await writeFile(path.join(root, 'src/data/models.json'), '[]\n'); }, true],
		['committed twins are symlinks (even to identical bytes)', async (root) => {
			await mkdir(path.join(root, 'src/data'), { recursive: true });
			await writeFile(path.join(root, 'real-scene.json'), EMPTY_SCENE_TEXT);
			await writeFile(path.join(root, 'real-models.json'), '[]\n');
			await symlink(path.join(root, 'real-scene.json'), path.join(root, 'src/data/scene.json'));
			await symlink(path.join(root, 'real-models.json'), path.join(root, 'src/data/models.json'));
		}, true],
	];
	for (const [name, setup, expected] of cases) {
		const { root, store } = await makeRoot({ bare: true });
		await setup(root);
		assert.equal(await store.differs(), expected, name);
	}
});

test('differs is read-only: it never writes the committed files nor follows a committed symlink out of the repo', async () => {
	const { root, store } = await makeRoot();
	const outside = path.join(tmpBase, `outside${n++}`);
	await mkdir(outside);
	await writeFile(path.join(outside, 'scene.json'), 'OUTSIDE');
	await rm(path.join(root, 'src/data/scene.json'));
	await symlink(path.join(outside, 'scene.json'), path.join(root, 'src/data/scene.json'));
	assert.equal(await store.differs(), true);
	assert.equal(await readFile(path.join(outside, 'scene.json'), 'utf8'), 'OUTSIDE');
	assert.deepEqual(await readdir(outside), ['scene.json']);
});

test('local/ files are real hard-link-free regular files after creation (a link() based create leaves only one name)', async () => {
	const { abs, store } = await makeRoot({ bare: true });
	await store.ensureLocal();
	for (const f of ['local/scene.json', 'local/models.json']) assert.equal((await stat(abs(f))).nlink, 1, `${f} has a single link (the temp name is gone)`);
	// link() over an existing name is what protects an existing file: prove the primitive refuses to replace
	await assert.rejects(link(abs('local/scene.json'), abs('local/models.json')), { code: 'EEXIST' });
});
