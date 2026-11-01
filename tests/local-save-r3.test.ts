// Round-3 tests for the dev-only local save: (1) the per-file size cap and the model-id rule come from the LIVE
// validators (a raised/lowered cap or a changed id rule applies on the next request, no source file is edited — the
// "live" modules are injected, or served by a mock SSR runner); (2) the stale-temp sweep matches ONLY the exact temp
// names atomicWrite creates, in the right directory, as regular files, in a real (non-symlinked) directory.
// Temp repo roots: tests/.tmp-local-save-r3-*, removed in after().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalSaveError, createLocalSave, gitBlobSha, parseCommitBody, HARD_MAX_FILE_BYTES, MAX_FILE_BYTES, SCENE_PATH, MODELS_PATH } from '../dev/local-save-core.mjs';
import { MAX_MODEL_BYTES, validateGlb } from '../src/scripts/admin/model-file.ts';
import { emptyScene, serializeScene, validateScene, parseScene, parseModels, modelIdOf } from '../src/data/scene.ts';
import { makeBoxGlb } from './helpers/gltf-fixtures.ts';
import { makeHarness } from './helpers/local-save-http.ts';

const SLUGS = ['elnur', 'sabina', 'nadir', 'chinara', 'alibala', 'elkhan', 'fazil'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB = makeBoxGlb();
const G = { 'x-alishly-local-save': '1' };
const HEADER_PLUS = 64 * 1024 + 4; // commit body = 4 x cap + header allowance (+ 4 length bytes)

let base = '';
let n = 0;
before(async () => {
	base = await mkdtemp(path.join(HERE, '.tmp-local-save-r3-'));
});
after(async () => {
	if (base) await rm(base, { recursive: true, force: true });
});

async function makeRepo() {
	const root = path.join(base, `repo${n++}`);
	await mkdir(path.join(root, 'src/data'), { recursive: true });
	await mkdir(path.join(root, 'public/models'), { recursive: true });
	await writeFile(path.join(root, SCENE_PATH), serializeScene(emptyScene(SLUGS)));
	await writeFile(path.join(root, MODELS_PATH), '[]\n');
	return root;
}

const DEFAULTS = { validateScene, parseScene, parseModels, modelIdOf, validateGlb };
type Live = typeof DEFAULTS & { maxModelBytes?: unknown };
/** A store whose validators (cap, id rule, glb rule) are read from a mutable object on every call, like the plugin does. */
async function liveStore(overrides: Partial<Live> = {}) {
	const root = await makeRepo();
	const live: Live = { ...DEFAULTS, ...overrides };
	const store = createLocalSave({ root, slugs: SLUGS, validators: async () => ({ ...live }) as never });
	return { root, live, store };
}
const status = (e: unknown) => (e instanceof LocalSaveError ? `${e.status} ${e.kind}` : String(e));
const rejectsWith = (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: unknown) => status(e) === expected, `expected ${expected}`);
const acceptAnyGlb = (_bytes: Uint8Array) => ({}) as never;
const blob = (size: number) => new Uint8Array(size).fill(1);

// ---- limits(): the cap in force now ----------------------------------------------------------------------------

test('limits(): without maxModelBytes the imported default applies (and the commit body limit keeps its formula)', async () => {
	const { store } = await liveStore();
	const l = await store.limits();
	assert.equal(l.maxFileBytes, MAX_MODEL_BYTES);
	assert.equal(l.maxFileBytes, MAX_FILE_BYTES);
	assert.equal(l.maxCommitBody, 4 * MAX_MODEL_BYTES + HEADER_PLUS);
});

test('limits(): follows the validators cap, floors it, re-reads it on every call, clamps absurd values, ignores invalid ones', async () => {
	const { store, live } = await liveStore();
	live.maxModelBytes = 1000;
	assert.deepEqual([(await store.limits()).maxFileBytes, (await store.limits()).maxCommitBody], [1000, 4000 + HEADER_PLUS]);
	live.maxModelBytes = 5000;
	assert.equal((await store.limits()).maxFileBytes, 5000, 'a changed cap applies on the next call');
	live.maxModelBytes = 1500.9;
	assert.equal((await store.limits()).maxFileBytes, 1500);
	live.maxModelBytes = 1e12;
	assert.equal((await store.limits()).maxFileBytes, HARD_MAX_FILE_BYTES, 'a typo cannot lift the cap beyond the hard ceiling');
	assert.equal(HARD_MAX_FILE_BYTES, 256 * 1024 * 1024);
	assert.equal((await store.limits()).maxCommitBody, 4 * HARD_MAX_FILE_BYTES + HEADER_PLUS);
	for (const bad of [Number.NaN, Infinity, -Infinity, 0, -5, '9999', null, undefined, {}, true]) {
		live.maxModelBytes = bad;
		assert.equal((await store.limits()).maxFileBytes, MAX_MODEL_BYTES, `invalid cap ${String(bad)} falls back to the default`);
	}
});

test('limits(): validators that cannot load are a 500 "could not load the scene rules" (cause kept, no path)', async () => {
	const root = await makeRepo();
	const store = createLocalSave({ root, slugs: SLUGS, validators: async () => { throw new Error(`boom ${root}`); } });
	await assert.rejects(store.limits(), (e: unknown) => {
		assert.ok(e instanceof LocalSaveError);
		assert.equal(e.status, 500);
		assert.match(e.message, /could not load the scene rules/);
		assert.ok(!e.message.includes(root));
		assert.ok(e.cause instanceof Error);
		return true;
	});
});

// ---- the cap really is used: writeFile, commit, readText ---------------------------------------------------------

test('writeFile: a RAISED live cap accepts an upload that the default cap refuses (no source edit, no restart)', async () => {
	const big = blob(MAX_MODEL_BYTES + 1000);
	const stale = await liveStore({ validateGlb: acceptAnyGlb as never });
	await rejectsWith(stale.store.writeFile('public/models/big.glb', big, null), '413 too-large');
	const { store, live, root } = await liveStore({ validateGlb: acceptAnyGlb as never });
	await rejectsWith(store.writeFile('public/models/big.glb', big, null), '413 too-large');
	live.maxModelBytes = MAX_MODEL_BYTES + 2000; // "someone edited MAX_MODEL_BYTES"
	const r = await store.writeFile('public/models/big.glb', big, null);
	assert.equal(r.bytes, big.byteLength);
	assert.equal(r.sha, gitBlobSha(big));
	assert.equal((await lstat(path.join(root, 'public/models/big.glb'))).size, big.byteLength);
	// and a body over even the raised cap is still refused
	await rejectsWith(store.writeFile('public/models/bigger.glb', blob(MAX_MODEL_BYTES + 2001), null), '413 too-large');
});

test('writeFile: a LOWERED live cap refuses what was accepted a moment ago; the 413 message names the live limit', async () => {
	const { store, live } = await liveStore();
	const ok = await store.writeFile('public/models/chair.glb', GLB, null);
	assert.equal(ok.bytes, GLB.byteLength);
	live.maxModelBytes = GLB.byteLength - 1;
	await assert.rejects(store.writeFile('public/models/chair2.glb', GLB, null), (e: unknown) => e instanceof LocalSaveError && e.status === 413 && /larger than the .* MB limit/.test(e.message));
	live.maxModelBytes = GLB.byteLength; // exactly the cap is fine
	await store.writeFile('public/models/chair2.glb', GLB, null);
});

test('the cap applies to scene.json / models.json bodies too (same per-file rule)', async () => {
	const { store, live } = await liveStore();
	const sceneSha = (await store.readText(SCENE_PATH)).sha;
	const text = Buffer.from(serializeScene(emptyScene(SLUGS)));
	live.maxModelBytes = text.byteLength - 1;
	await rejectsWith(store.writeFile(SCENE_PATH, text, sceneSha), '413 too-large');
	live.maxModelBytes = text.byteLength + 1;
	await store.writeFile(SCENE_PATH, text, sceneSha);
});

test('readText: files larger than the live cap are 413, a raised cap serves them', async () => {
	const { store, live, root } = await liveStore();
	const text = serializeScene(emptyScene(SLUGS));
	await writeFile(path.join(root, SCENE_PATH), text);
	live.maxModelBytes = Buffer.byteLength(text) - 1;
	await rejectsWith(store.readText(SCENE_PATH), '413 too-large');
	live.maxModelBytes = Buffer.byteLength(text);
	assert.equal((await store.readText(SCENE_PATH)).text, text);
});

function frame(expectedHead: string, changes: Array<{ path: string; op: 'write'; bytes: Uint8Array } | { path: string; op: 'delete' }>) {
	const described = changes.map((c) => (c.op === 'delete' ? { path: c.path, op: 'delete' } : { path: c.path, op: 'write', size: c.bytes.byteLength }));
	const header = Buffer.from(JSON.stringify({ expectedHead, changes: described }));
	const len = Buffer.alloc(4);
	len.writeUInt32BE(header.byteLength, 0);
	return Buffer.concat([len, header, ...changes.flatMap((c) => (c.op === 'write' ? [Buffer.from(c.bytes)] : []))]);
}

test('commit: the per-file cap (413) and the total body limit follow the live cap', async () => {
	const { store, live } = await liveStore({ validateGlb: acceptAnyGlb as never });
	live.maxModelBytes = 3000;
	const head = (await store.head()).head;
	await rejectsWith(store.commit(frame(head, [{ path: 'public/models/a.glb', op: 'write', bytes: blob(3001) }])), '413 too-large');
	const fine = await store.commit(frame(head, [{ path: 'public/models/a.glb', op: 'write', bytes: blob(3000) }]));
	assert.deepEqual(fine.written, ['public/models/a.glb']);
	// raising the cap lets the same file size that was refused through
	live.maxModelBytes = 8000;
	const head2 = (await store.head()).head;
	const ok = await store.commit(frame(head2, [{ path: 'public/models/b.glb', op: 'write', bytes: blob(7000) }]));
	assert.deepEqual(ok.written, ['public/models/b.glb']);
	// total body: more than 4 x cap + header allowance is refused before parsing
	live.maxModelBytes = 1000;
	await rejectsWith(store.commit(Buffer.alloc(4 * 1000 + HEADER_PLUS + 1)), '413 too-large');
});

test('parseCommitBody: the optional third parameter is the per-file cap; default unchanged', () => {
	const body = frame('0'.repeat(40), [{ path: 'public/models/a.glb', op: 'write', bytes: blob(100) }]);
	assert.equal(parseCommitBody(body).changes.length, 1);
	assert.throws(() => parseCommitBody(body, parseModels, 99), (e: unknown) => status(e) === '413 too-large');
	assert.equal(parseCommitBody(body, parseModels, 100).changes.length, 1);
});

// ---- the model-id rule is the live one -------------------------------------------------------------------------

test('limits().classify uses the LIVE parseModels: an id rule that tightens or loosens applies on the next call', async () => {
	const { store, live } = await liveStore();
	assert.equal((await store.limits()).classify('public/models/Chair.glb')?.kind, 'glb');
	// the live rule now only accepts lower-case ids
	live.parseModels = ((input: unknown[]) => (parseModels(input).filter((m) => /^[a-z]+$/.test(m.id)))) as never;
	const l = await store.limits();
	assert.equal(l.classify('public/models/Chair.glb'), null);
	assert.equal(l.classify('public/models/chair.glb')?.kind, 'glb');
	assert.equal(l.classify('src/data/scene.json')?.kind, 'scene');
	assert.equal(l.classify('public/models/../scene.glb'), null);
	// and the store's own operations follow it
	await rejectsWith(store.writeFile('public/models/Chair.glb', GLB, null), '403 forbidden');
	await store.writeFile('public/models/chair.glb', GLB, null);
	assert.equal((await store.blobSha('public/models/chair.glb')).sha, gitBlobSha(GLB));
	await rejectsWith(store.blobSha('public/models/Chair.glb'), '403 forbidden');
});

// ---- over HTTP: the plugin sizes its body read from the live cap ---------------------------------------------

const REAL = { scene: () => import('../src/data/scene.ts'), file: () => import('../src/scripts/admin/model-file.ts'), family: () => import('../src/data/family.ts') };
async function runnerHarness(live: { cap?: number; accept?: boolean; parse?: (i: unknown[]) => unknown[] }) {
	const root = await makeRepo();
	const runner = {
		import: async (p: string) => {
			if (p.endsWith('family.ts')) return REAL.family();
			if (p.endsWith('scene.ts')) {
				const m = await REAL.scene();
				return live.parse ? { ...m, parseModels: live.parse } : m;
			}
			const m = await REAL.file();
			return { ...m, ...(live.cap === undefined ? {} : { MAX_MODEL_BYTES: live.cap }), ...(live.accept ? { validateGlb: acceptAnyGlb } : {}) };
		},
	};
	const h = await makeHarness({ root, environments: { ssr: { runner } } });
	await h.ready();
	return { h, root };
}
const putGlb = (h: Awaited<ReturnType<typeof makeHarness>>, id: string, body: Uint8Array, headers: Record<string, string> = {}) =>
	h.fetch(`/__local-save/file?path=${encodeURIComponent(`public/models/${id}.glb`)}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/octet-stream', ...headers }, body });

test('HTTP: a raised MAX_MODEL_BYTES (served by the runner) lets a bigger upload through; the default refuses the same body with 413', async () => {
	const big = blob(MAX_MODEL_BYTES + 5000);
	const def = await runnerHarness({ accept: true });
	assert.equal((await putGlb(def.h, 'big', big)).status, 413);
	const raised = await runnerHarness({ cap: MAX_MODEL_BYTES + 10_000, accept: true });
	const res = await putGlb(raised.h, 'big', big);
	assert.equal(res.status, 200);
	assert.equal((await lstat(path.join(raised.root, 'public/models/big.glb'))).size, big.byteLength);
	// beyond the raised cap: refused (declared length) and the connection is closed
	const over = await putGlb(raised.h, 'bigger', blob(MAX_MODEL_BYTES + 10_001));
	assert.equal(over.status, 413);
	assert.equal(over.headers.get('connection'), 'close');
});

test('HTTP: a LOWERED cap refuses a body above it before reading it; a body at the cap is fine; no file is left', async () => {
	const { h, root } = await runnerHarness({ cap: GLB.byteLength, accept: false });
	const tooBig = new Uint8Array(GLB.byteLength + 1);
	tooBig.set(GLB);
	const r = await putGlb(h, 'chair', tooBig);
	assert.equal(r.status, 413);
	assert.equal(r.headers.get('connection'), 'close');
	assert.deepEqual((await readdir(path.join(root, 'public/models'))).filter((f) => !f.startsWith('.')), []);
	assert.equal((await putGlb(h, 'chair', GLB)).status, 200);
});

test('HTTP: a lying Content-Length is still cut off at the live cap', async () => {
	const { h } = await runnerHarness({ cap: 2000, accept: true });
	const res = await putGlb(h, 'liar', blob(5000), { 'content-length': '10' });
	assert.equal(res.status, 413);
});

test('HTTP commit: the body limit follows the live cap (4 x cap + header allowance)', async () => {
	const { h } = await runnerHarness({ cap: 2000, accept: true });
	const head = (await (await h.fetch('/__local-save/head', { headers: G })).json()).head;
	const post = (body: Uint8Array) => h.fetch('/__local-save/commit', { method: 'POST', headers: { ...G, 'content-type': 'application/octet-stream' }, body });
	assert.equal((await post(frame(head, [{ path: 'public/models/a.glb', op: 'write', bytes: blob(2000) }]))).status, 200);
	const head2 = (await (await h.fetch('/__local-save/head', { headers: G })).json()).head;
	assert.equal((await post(frame(head2, [{ path: 'public/models/b.glb', op: 'write', bytes: blob(2001) }]))).status, 413);
	assert.equal((await post(Buffer.alloc(4 * 2000 + HEADER_PLUS + 1))).status, 413);
});

test('HTTP: the id rule from the runner decides the early 403 (before the body is read)', async () => {
	const { h } = await runnerHarness({ parse: (i) => (parseModels(i) as Array<{ id: string }>).filter((m) => /^[a-z]+$/.test(m.id)) });
	const upper = await putGlb(h, 'Chair', GLB);
	assert.equal(upper.status, 403);
	assert.equal((await putGlb(h, 'chair', GLB)).status, 200);
});

// ---- the sweep matches only the exact own temp names ----------------------------------------------------------

const OLD = 10 * 60_000;
async function plant(root: string, rel: string, ageMs = OLD, content = 'junk') {
	const file = path.join(root, rel);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, content);
	const when = new Date(Date.now() - ageMs);
	await utimes(file, when, when);
}
const exists = (p: string) => lstat(p).then(() => true, () => false);
const HEX = '0123456789ab';

test('sweep: removes exactly .scene.json / .models.json temps in src/data and .<valid-id>.glb temps in public/models', async () => {
	const root = await makeRepo();
	const store = createLocalSave({ root, slugs: SLUGS });
	const own = [`src/data/.scene.json.${HEX}.tmp`, `src/data/.models.json.${HEX}.tmp`, `public/models/.chair.glb.${HEX}.tmp`, `public/models/.Tall_House-9.glb.${HEX}.tmp`];
	for (const f of own) await plant(root, f);
	const removed = await store.sweepStaleTemp();
	assert.deepEqual([...removed].sort(), [...own].sort());
	for (const f of own) assert.equal(await exists(path.join(root, f)), false, f);
});

test('sweep: decoys with similar names are left alone (wrong file, wrong dir, wrong hex, wrong extension, bad id)', async () => {
	const root = await makeRepo();
	const store = createLocalSave({ root, slugs: SLUGS });
	const decoys = [
		// src/data: only scene.json / models.json temps
		`src/data/.other.json.${HEX}.tmp`,
		`src/data/.scene.json.${HEX}.tmp.bak`,
		`src/data/..scene.json.${HEX}.tmp`,
		`src/data/.scene.jsonx.${HEX}.tmp`,
		`src/data/.scene.json.${HEX.toUpperCase()}.tmp`, // upper-case hex is not what randomBytes().toString('hex') makes
		`src/data/.scene.json.${HEX}x.tmp`, // 13 chars
		`src/data/.scene.json.${HEX.slice(1)}.tmp`, // 11 chars
		`src/data/.scene.json.${HEX}.TMP`,
		`src/data/scene.json.${HEX}.tmp`, // no leading dot
		`src/data/.chair.glb.${HEX}.tmp`, // a glb temp does not belong in src/data
		`src/data/.scene.json.${HEX.replace('a', 'g')}.tmp`, // not hex
		// public/models: only .<id>.glb temps
		`public/models/.scene.json.${HEX}.tmp`, // a json temp does not belong in public/models
		`public/models/.models.json.${HEX}.tmp`,
		`public/models/.chair.${HEX}.tmp`, // no .glb
		`public/models/.chair.gltf.${HEX}.tmp`,
		`public/models/.bad id.glb.${HEX}.tmp`, // space: not a model id
		`public/models/.bad.id.glb.${HEX}.tmp`, // dot: not a model id (id would be "bad.id")
		`public/models/.chair.glb.${HEX}`, // no .tmp
		`public/models/chair.glb.${HEX}.tmp`, // no leading dot
		`public/models/.chair.glb.zzzzzzzzzzzz.tmp`,
		// plain user files that must never be touched
		'src/data/notes.txt',
		'public/models/readme.md',
		// other directories with the exact own name
		`src/.scene.json.${HEX}.tmp`,
		`public/.chair.glb.${HEX}.tmp`,
		`.scene.json.${HEX}.tmp`,
		`public/models/sub/.chair.glb.${HEX}.tmp`,
		`src/data/sub/.scene.json.${HEX}.tmp`,
	];
	for (const f of decoys) await plant(root, f);
	assert.deepEqual(await store.sweepStaleTemp(), []);
	for (const f of decoys) assert.equal(await readFile(path.join(root, f), 'utf8'), 'junk', `${f} must be untouched`);
	// the real data files survive too
	assert.equal(await exists(path.join(root, SCENE_PATH)), true);
	assert.equal(await exists(path.join(root, MODELS_PATH)), true);
});

test('sweep: a fresh own temp (younger than 60 s) stays; one just over the threshold goes', async () => {
	const root = await makeRepo();
	const store = createLocalSave({ root, slugs: SLUGS });
	await plant(root, `src/data/.scene.json.${HEX}.tmp`, 30_000);
	await plant(root, `src/data/.models.json.${HEX}.tmp`, 61_000);
	assert.deepEqual(await store.sweepStaleTemp(), [`src/data/.models.json.${HEX}.tmp`]);
	assert.equal(await exists(path.join(root, `src/data/.scene.json.${HEX}.tmp`)), true);
});

test('sweep: non-regular files with an own-looking name are left alone (directory, symlink to a file, dangling symlink, symlink to outside)', async () => {
	const root = await makeRepo();
	const outside = path.join(base, `outside${n++}`);
	await mkdir(outside, { recursive: true });
	await writeFile(path.join(outside, 'precious.txt'), 'keep me');
	await mkdir(path.join(root, `src/data/.scene.json.${HEX}.tmp`)); // a directory
	await writeFile(path.join(root, 'target.txt'), 'target');
	await symlink(path.join(root, 'target.txt'), path.join(root, `src/data/.models.json.${HEX}.tmp`)); // symlink to a file
	await symlink(path.join(root, 'does-not-exist'), path.join(root, `public/models/.chair.glb.${HEX}.tmp`)); // dangling
	await symlink(path.join(outside, 'precious.txt'), path.join(root, `public/models/.other.glb.${HEX}.tmp`)); // outside the repo
	const old = new Date(Date.now() - OLD);
	await utimes(path.join(root, `src/data/.scene.json.${HEX}.tmp`), old, old);
	const store = createLocalSave({ root, slugs: SLUGS });
	assert.deepEqual(await store.sweepStaleTemp(), []);
	assert.equal((await lstat(path.join(root, `src/data/.scene.json.${HEX}.tmp`))).isDirectory(), true);
	for (const f of [`src/data/.models.json.${HEX}.tmp`, `public/models/.chair.glb.${HEX}.tmp`, `public/models/.other.glb.${HEX}.tmp`]) {
		assert.equal((await lstat(path.join(root, f))).isSymbolicLink(), true, `${f} still a symlink`);
	}
	assert.equal(await readFile(path.join(root, 'target.txt'), 'utf8'), 'target');
	assert.equal(await readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
});

test('sweep: a SYMLINKED public/models (or src/data) is not swept — nothing outside the repo is touched or removed', async () => {
	for (const linked of ['public/models', 'src/data']) {
		const root = await makeRepo();
		const outside = path.join(base, `outside${n++}`);
		await mkdir(outside, { recursive: true });
		const name = linked === 'public/models' ? `.chair.glb.${HEX}.tmp` : `.scene.json.${HEX}.tmp`;
		await plant(outside, name);
		await rm(path.join(root, linked), { recursive: true });
		await symlink(outside, path.join(root, linked));
		const marks: string[] = [];
		const store = createLocalSave({ root, slugs: SLUGS, onWrite: (p: string) => marks.push(p) });
		assert.deepEqual(await store.sweepStaleTemp(), [], linked);
		assert.equal(await readFile(path.join(outside, name), 'utf8'), 'junk', `${linked}: file behind the symlinked dir kept`);
		assert.deepEqual(marks, [], 'nothing marked');
	}
});

test('sweep: the other directory is still swept when one is symlinked or missing', async () => {
	const root = await makeRepo();
	const outside = path.join(base, `outside${n++}`);
	await mkdir(outside, { recursive: true });
	await plant(outside, `.chair.glb.${HEX}.tmp`);
	await rm(path.join(root, 'public/models'), { recursive: true });
	await symlink(outside, path.join(root, 'public/models'));
	await plant(root, `src/data/.scene.json.${HEX}.tmp`);
	const store = createLocalSave({ root, slugs: SLUGS });
	assert.deepEqual(await store.sweepStaleTemp(), [`src/data/.scene.json.${HEX}.tmp`]);
	assert.equal(await exists(path.join(outside, `.chair.glb.${HEX}.tmp`)), true);
	// missing public/ entirely
	await rm(path.join(root, 'public'), { recursive: true });
	await plant(root, `src/data/.models.json.${HEX}.tmp`);
	assert.deepEqual(await store.sweepStaleTemp(), [`src/data/.models.json.${HEX}.tmp`]);
});

test('sweep: uses the injected id rule only for the glb dir, and removals are marked via onWrite', async () => {
	const root = await makeRepo();
	const marks: string[] = [];
	const store = createLocalSave({ root, slugs: SLUGS, onWrite: (p: string) => marks.push(p) });
	await plant(root, `public/models/.chair.glb.${HEX}.tmp`);
	await plant(root, `src/data/.scene.json.${HEX}.tmp`);
	await store.sweepStaleTemp();
	assert.ok(marks.includes(path.join(root, `public/models/.chair.glb.${HEX}.tmp`)));
	assert.ok(marks.includes(path.join(root, `src/data/.scene.json.${HEX}.tmp`)));
});

test('sweep: what atomicWrite creates is what the sweep recognises (names produced by real writes match the patterns)', async () => {
	const root = await makeRepo();
	const seen: string[] = [];
	const store = createLocalSave({ root, slugs: SLUGS, onWrite: (p: string) => seen.push(path.relative(root, p)) });
	const sha = (await store.readText(SCENE_PATH)).sha;
	await store.writeFile(SCENE_PATH, Buffer.from(serializeScene(emptyScene(SLUGS)) + '\n'), sha).catch(() => {});
	await store.writeFile('public/models/chair.glb', GLB, null);
	const temps = [...new Set(seen.filter((p) => p.endsWith('.tmp')))];
	assert.ok(temps.length >= 2, `writes produced temp names: ${temps.join(', ')}`);
	// plant one file per produced name, age it, sweep: every one of them is recognised and removed
	for (const t of temps) await plant(root, t);
	assert.deepEqual([...(await store.sweepStaleTemp())].sort(), [...temps].sort());
});
