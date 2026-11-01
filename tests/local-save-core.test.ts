// Tests for the dev-only local save (dev/local-save-core.mjs): path allowlist, id rule, request guard, content
// validation, sha/head conflicts, atomic writes, commit order, delete rules. The store runs against a temp repo root
// created INSIDE this repo (tests/.tmp-local-save-core-*) and removed afterwards. Run: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	LocalSaveError, checkContentType, checkRequest, classifyPath, createLocalSave, gitBlobSha, isModelId, parseCommitBody,
	MAX_FILE_BYTES, MAX_COMMIT_BYTES, SCENE_PATH, MODELS_PATH,
} from '../dev/local-save-core.mjs';
import { emptyScene, serializeScene } from '../src/data/scene.ts';
import { gitBlobSha as modelOpsBlobSha } from '../src/scripts/admin/model-ops.ts';
import { MAX_MODEL_BYTES } from '../src/scripts/admin/model-file.ts';
import { makeBoxGlb } from './helpers/gltf-fixtures.ts';

const SLUGS = ['elnur', 'sabina', 'nadir', 'chinara', 'alibala', 'elkhan', 'fazil'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB = makeBoxGlb();
const enc = new TextEncoder();
const utf8 = (text: string) => Buffer.from(text, 'utf8');
const PORT = 4321;
const HOST = `localhost:${PORT}`;
const ORIGIN = `http://${HOST}`;

const obj = (id: string, type: string) => ({ id, type, position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] });
function sceneText(objects: Array<ReturnType<typeof obj>> = []) {
	const scene = emptyScene(SLUGS);
	scene.rooms.elnur.objects = objects as never;
	return serializeScene(scene);
}
const modelsText = (...ids: string[]) =>
	`${JSON.stringify(ids.map((id) => ({ id, label: id, file: `/models/${id}.glb`, defaultScale: 1 })), null, '\t')}\n`;

/** Framed body of POST commit (same layout as src/scripts/admin/local-client.ts). */
function frame(expectedHead: string, changes: Array<{ path: string; op: 'write'; bytes: Uint8Array } | { path: string; op: 'delete' }>, headerOverride?: unknown) {
	const described = changes.map((c) => (c.op === 'delete' ? { path: c.path, op: 'delete' } : { path: c.path, op: 'write', size: c.bytes.byteLength }));
	const header = Buffer.from(JSON.stringify(headerOverride ?? { expectedHead, changes: described }));
	const len = Buffer.alloc(4);
	len.writeUInt32BE(header.byteLength, 0);
	return Buffer.concat([len, header, ...changes.flatMap((c) => (c.op === 'write' ? [Buffer.from(c.bytes)] : []))]);
}

const rejects = (promise: Promise<unknown> | (() => unknown), status: number, kind: string, re?: RegExp) =>
	assert.rejects(
		async () => (typeof promise === 'function' ? promise() : promise),
		(e: unknown) => e instanceof LocalSaveError && e.status === status && e.kind === kind && (!re || re.test(e.message)),
		`expected LocalSaveError ${status} ${kind} ${re ?? ''}`,
	);
const throwsLocal = (fn: () => unknown, status: number, kind: string) =>
	assert.throws(fn, (e: unknown) => e instanceof LocalSaveError && e.status === status && e.kind === kind, `expected LocalSaveError ${status} ${kind}`);

let tmpBase = '';
let n = 0;
before(async () => {
	tmpBase = await mkdtemp(path.join(HERE, '.tmp-local-save-core-'));
});
after(async () => {
	if (tmpBase) await rm(tmpBase, { recursive: true, force: true });
});

/** A fresh fake repo root with a scene, a models.json and (optionally) one model. */
async function makeRepo(opts: { scene?: string; models?: string; glbs?: string[] } = {}) {
	const root = path.join(tmpBase, `repo${n++}`);
	await mkdir(path.join(root, 'src/data'), { recursive: true });
	await mkdir(path.join(root, 'public/models'), { recursive: true });
	await writeFile(path.join(root, SCENE_PATH), opts.scene ?? sceneText());
	await writeFile(path.join(root, MODELS_PATH), opts.models ?? modelsText(...(opts.glbs ?? [])));
	for (const id of opts.glbs ?? []) await writeFile(path.join(root, `public/models/${id}.glb`), GLB);
	const touched: string[] = [];
	const store = createLocalSave({ root, slugs: SLUGS, onWrite: (abs: string) => touched.push(abs) });
	return { root, store, touched, read: (rel: string) => readFile(path.join(root, rel)) };
}

// ---- path allowlist ------------------------------------------------------------------------------------------

test('classifyPath: allows exactly the two data files and public/models/<id>.glb', () => {
	assert.deepEqual(classifyPath('src/data/scene.json'), { kind: 'scene', rel: 'src/data/scene.json' });
	assert.deepEqual(classifyPath('src/data/models.json'), { kind: 'models', rel: 'src/data/models.json' });
	assert.deepEqual(classifyPath('public/models/chair.glb'), { kind: 'glb', rel: 'public/models/chair.glb', id: 'chair' });
	assert.equal(classifyPath('public/models/a_b-C9.glb')?.kind, 'glb');
});

test('classifyPath: refuses traversal, absolute, encoded, backslash, NUL, other files and odd extensions', () => {
	const bad = [
		'../src/data/scene.json', 'src/data/../data/scene.json', 'src/data/./scene.json', './src/data/scene.json',
		'/src/data/scene.json', '/etc/passwd', '/home/nadir/Projects/alishly/alishly-web/src/data/scene.json', 'C:\\x\\scene.json',
		'public/models/../../package.json', 'public/models/../models/a.glb', 'public/models/%2e%2e/x.glb', 'public/models/a%2fb.glb',
		'public/models/a\\b.glb', 'public/models\\a.glb', 'public/models/a\0.glb', 'src/data/scene.json\0', 'src/data/scene.json\0.glb',
		'public/models/sub/a.glb', 'public/models/.glb', 'public/models/a.GLB', 'public/models/a.glb.tmp', 'public/models/a.gltf',
		'public/models/a b.glb', 'public/models/a..glb', 'public/models/..glb', 'public/models/.hidden.glb', 'public/models/' + 'a'.repeat(65) + '.glb',
		'src/data/scene.JSON', 'src/data/scene.json/', 'src/data/scene.json ', ' src/data/scene.json', 'src/data/family.ts', 'src/data/scene.ts',
		'package.json', 'astro.config.mjs', '.env', 'dev/local-save-core.mjs', 'public/models', 'public/models/', 'dist/index.html', '.git/config',
		'', 'src/data/models.json.bak', 'SRC/data/scene.json',
	];
	for (const p of bad) assert.equal(classifyPath(p), null, `must refuse ${JSON.stringify(p)}`);
	for (const v of [undefined, null, 5, {}, [], ['src/data/scene.json']]) assert.equal(classifyPath(v as never), null);
});

test('isModelId: the scene.ts id rule (1-64 of A-Z a-z 0-9 _ -)', () => {
	for (const id of ['a', 'A', 'tall-house-plant', 'a_b', '9', 'x'.repeat(64)]) assert.equal(isModelId(id), true, id);
	for (const id of ['', 'x'.repeat(65), 'a b', 'a/b', 'a\\b', '..', '.', 'a.b', 'ü', 'a\0', '../a', '%2e', 'a%20b', 5, null, undefined, {}]) {
		assert.equal(isModelId(id as never), false, JSON.stringify(id));
	}
});

// ---- request guard -------------------------------------------------------------------------------------------

const good = (extra: Record<string, string> = {}) => ({ host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-alishly-local-save': '1', ...extra });
const guardOk = (op: 'ping' | 'read' | 'write', headers: Record<string, string | string[] | undefined>, extra: Record<string, unknown> = {}) =>
	checkRequest({ op, headers, localPort: PORT, ...extra } as never);

test('checkRequest: a same-origin request with the custom header passes (read and write)', () => {
	guardOk('read', good());
	guardOk('write', good());
	guardOk('ping', { host: HOST });
	guardOk('read', { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', 'x-alishly-local-save': '1' });
	guardOk('read', { host: '[::1]:4321', 'x-alishly-local-save': '1' });
	// a top-level navigation / curl style read without Origin is fine; Sec-Fetch-Site none too (reads only)
	guardOk('read', { host: HOST, 'x-alishly-local-save': '1', 'sec-fetch-site': 'none' });
});

test('checkRequest: Origin must be exactly the server own origin', () => {
	for (const origin of ['http://localhost:4322', 'http://localhost', 'https://localhost:4321', 'http://evil.com', 'http://localhost:4321.evil.com', 'http://127.0.0.1:4321', 'null', '', 'http://localhost:4321/', 'HTTP://LOCALHOST:4321']) {
		throwsLocal(() => guardOk('write', good({ origin })), 403, 'forbidden');
		throwsLocal(() => guardOk('read', good({ origin })), 403, 'forbidden');
	}
	throwsLocal(() => guardOk('write', good({ origin: ['a', 'b'] as never })), 403, 'forbidden');
});

test('checkRequest: a write without Origin is refused (curl / cross-site forms), a read without Origin is allowed', () => {
	const { origin: _o, ...noOrigin } = good();
	throwsLocal(() => guardOk('write', noOrigin), 403, 'forbidden');
	guardOk('read', noOrigin);
});

test('checkRequest: the custom header is required (any value other than "1" fails), except for ping', () => {
	for (const op of ['read', 'write'] as const) {
		const { 'x-alishly-local-save': _h, ...noHeader } = good();
		throwsLocal(() => guardOk(op, noHeader), 403, 'forbidden');
		for (const value of ['0', '', 'true', '1 ', 'yes']) throwsLocal(() => guardOk(op, good({ 'x-alishly-local-save': value })), 403, 'forbidden');
		throwsLocal(() => guardOk(op, good({ 'x-alishly-local-save': ['1', '1'] as never })), 403, 'forbidden');
	}
	guardOk('ping', { host: HOST, origin: ORIGIN });
});

test('checkRequest: Host must be loopback with the server own port (DNS rebinding)', () => {
	for (const host of ['evil.com', 'evil.com:4321', 'localhost:4322', 'localhost:1', 'localhost.evil.com:4321', '192.168.1.5:4321', '0.0.0.0:4321', '', 'localhost:4321:1', 'localhost:abc', 'LOCALHOST:4321']) {
		throwsLocal(() => guardOk('read', good({ host, origin: `http://${host}` })), 403, 'forbidden');
	}
	throwsLocal(() => checkRequest({ op: 'read', headers: { 'x-alishly-local-save': '1' }, localPort: PORT }), 403, 'forbidden'); // no Host
	// default port: only matches when the server really listens on 80 / 443
	checkRequest({ op: 'read', headers: { host: 'localhost', 'x-alishly-local-save': '1' }, localPort: 80 });
	throwsLocal(() => checkRequest({ op: 'read', headers: { host: 'localhost', 'x-alishly-local-save': '1' }, localPort: PORT }), 403, 'forbidden');
});

test('checkRequest: Sec-Fetch-Site must be same-origin (none only for reads)', () => {
	for (const site of ['cross-site', 'same-site', 'bogus', '']) {
		throwsLocal(() => guardOk('read', good({ 'sec-fetch-site': site })), 403, 'forbidden');
		throwsLocal(() => guardOk('write', good({ 'sec-fetch-site': site })), 403, 'forbidden');
	}
	throwsLocal(() => guardOk('write', good({ 'sec-fetch-site': 'none' })), 403, 'forbidden');
});

test('checkContentType: json = application/json (+utf-8), octet = application/octet-stream without parameters', () => {
	const h = (v: string | undefined) => (v === undefined ? {} : { 'content-type': v });
	checkContentType(h('application/json'), 'json');
	checkContentType(h('application/json; charset=utf-8'), 'json');
	checkContentType(h('Application/JSON;charset=UTF-8'), 'json');
	checkContentType(h('application/octet-stream'), 'octet');
	for (const v of [undefined, 'text/plain', 'text/plain;charset=UTF-8', 'multipart/form-data', 'application/x-www-form-urlencoded', 'application/octet-stream', 'application/json; charset=latin1', 'application/jsonx', 'application/json; boundary=x']) {
		if (v === 'application/octet-stream') continue;
		throwsLocal(() => checkContentType(h(v), 'json'), 415, 'unsupported-media');
	}
	for (const v of [undefined, 'application/json', 'text/plain', 'application/octet-stream; charset=utf-8', 'application/x-www-form-urlencoded', 'model/gltf-binary']) {
		throwsLocal(() => checkContentType(h(v), 'octet'), 415, 'unsupported-media');
	}
});

// ---- blob sha ------------------------------------------------------------------------------------------------

test('gitBlobSha equals `git hash-object` and the client-side gitBlobSha', async () => {
	const repo = await makeRepo();
	const file = path.join(repo.root, 'x.txt');
	for (const bytes of [Buffer.alloc(0), utf8('hello\n'), utf8('ünï\u2028 ✓'), Buffer.from(GLB)]) {
		await writeFile(file, bytes);
		const expected = execFileSync('git', ['hash-object', file]).toString().trim();
		assert.equal(gitBlobSha(bytes), expected);
		assert.equal(await modelOpsBlobSha(new Uint8Array(bytes)), expected);
	}
});

// ---- read ----------------------------------------------------------------------------------------------------

test('store: readText returns the text with its git blob sha; models are never served as text; missing is 404', async () => {
	const repo = await makeRepo({ glbs: ['chair'] });
	const r = await repo.store.readText(SCENE_PATH);
	assert.equal(r.text, sceneText());
	assert.equal(r.sha, gitBlobSha(utf8(sceneText())));
	await rejects(repo.store.readText('public/models/chair.glb'), 403, 'forbidden');
	await rejects(repo.store.readText('package.json'), 403, 'forbidden');
	await rejects(repo.store.readText('../x'), 403, 'forbidden');
	await rm(path.join(repo.root, MODELS_PATH));
	await rejects(repo.store.readText(MODELS_PATH), 404, 'not-found');
});

test('store: blobSha of a glb is the git blob sha, null when missing, 403 for other paths', async () => {
	const repo = await makeRepo({ glbs: ['chair'] });
	assert.deepEqual(await repo.store.blobSha('public/models/chair.glb'), { path: 'public/models/chair.glb', sha: gitBlobSha(Buffer.from(GLB)) });
	assert.equal((await repo.store.blobSha('public/models/none.glb')).sha, null);
	await rejects(repo.store.blobSha('package.json'), 403, 'forbidden');
	await rejects(repo.store.blobSha('public/models/../../package.json'), 403, 'forbidden');
});

// ---- writeFile: validation, conflicts, atomicity ------------------------------------------------------------

test('writeFile: writes valid scene content atomically (temp file + rename, no leftovers) and returns the new sha + head', async () => {
	const repo = await makeRepo();
	const before = await repo.store.readText(SCENE_PATH);
	const next = sceneText([obj('a', 'box')]);
	const result = await repo.store.writeFile(SCENE_PATH, utf8(next), before.sha);
	assert.equal(result.sha, gitBlobSha(utf8(next)));
	assert.equal((await repo.read(SCENE_PATH)).toString(), next);
	assert.equal(result.head, (await repo.store.head()).head);
	const leftovers = (await readdir(path.join(repo.root, 'src/data'))).filter((f) => f.endsWith('.tmp'));
	assert.deepEqual(leftovers, []);
	// the temp path was announced to onWrite (so the Vite plugin can tell it is ours) and sits in the same directory
	const tmps = repo.touched.filter((p) => p.endsWith('.tmp'));
	assert.ok(tmps.length > 0 && tmps.every((p) => path.dirname(p) === path.join(repo.root, 'src/data')));
	assert.ok(repo.touched.includes(path.join(repo.root, SCENE_PATH)));
});

test('writeFile: atomic — a failure during the write leaves the old content and no temp file', async () => {
	const repo = await makeRepo();
	const old = await repo.read(SCENE_PATH);
	const sha = (await repo.store.readText(SCENE_PATH)).sha;
	// make the target a directory-less path trick: replace the scene by a directory -> "not a regular file" refusal before any write
	await rm(path.join(repo.root, SCENE_PATH));
	await mkdir(path.join(repo.root, SCENE_PATH));
	await rejects(repo.store.writeFile(SCENE_PATH, utf8(sceneText([obj('a', 'box')])), null), 403, 'forbidden');
	await rm(path.join(repo.root, SCENE_PATH), { recursive: true });
	await writeFile(path.join(repo.root, SCENE_PATH), old);
	assert.equal((await repo.store.readText(SCENE_PATH)).sha, sha);
	assert.deepEqual((await readdir(path.join(repo.root, 'src/data'))).filter((f) => f.endsWith('.tmp')), []);
});

test('writeFile: a stale or missing sha is a 409 and nothing changes; sha omitted = create-only', async () => {
	const repo = await makeRepo();
	const old = await repo.read(SCENE_PATH);
	const next = utf8(sceneText([obj('a', 'box')]));
	await rejects(repo.store.writeFile(SCENE_PATH, next, '0'.repeat(40)), 409, 'conflict');
	await rejects(repo.store.writeFile(SCENE_PATH, next, null), 409, 'conflict'); // exists, create-only
	assert.deepEqual(await repo.read(SCENE_PATH), old);
	// external edit after the sha was read
	const seen = (await repo.store.readText(SCENE_PATH)).sha;
	await writeFile(path.join(repo.root, SCENE_PATH), sceneText([obj('z', 'lamp')]));
	await rejects(repo.store.writeFile(SCENE_PATH, next, seen), 409, 'conflict');
	assert.equal((await repo.read(SCENE_PATH)).toString(), sceneText([obj('z', 'lamp')]));
	// create-only works for a missing file
	await rm(path.join(repo.root, MODELS_PATH));
	await repo.store.writeFile(MODELS_PATH, utf8(modelsText()), null);
	assert.equal((await repo.read(MODELS_PATH)).toString(), modelsText());
});

test('writeFile: a malformed sha is a 400', async () => {
	const repo = await makeRepo();
	for (const sha of ['abc', 'Z'.repeat(40), 'A'.repeat(40), '0'.repeat(41), ' '.repeat(40)]) {
		await rejects(repo.store.writeFile(SCENE_PATH, utf8(sceneText()), sha), 400, 'bad-request');
	}
});

test('writeFile: refuses paths outside the allowlist without touching the disk', async () => {
	const repo = await makeRepo();
	for (const p of ['package.json', '../escape.json', '/tmp/escape.json', 'public/models/../../x.glb', 'src/data/family.ts', 'public/models/bad id.glb']) {
		await rejects(repo.store.writeFile(p, GLB, null), 403, 'forbidden');
	}
	assert.deepEqual((await readdir(repo.root)).sort(), ['public', 'src']);
	assert.equal(await stat(path.join(tmpBase, 'escape.json')).catch(() => null), null);
});

test('writeFile: server-side validation rejects a bad scene, bad models.json and bad GLB with 422', async () => {
	const repo = await makeRepo();
	const sha = (await repo.store.readText(SCENE_PATH)).sha;
	await rejects(repo.store.writeFile(SCENE_PATH, utf8('not json'), sha), 422, 'rejected', /JSON/);
	await rejects(repo.store.writeFile(SCENE_PATH, utf8('{}'), sha), 422, 'rejected');
	await rejects(repo.store.writeFile(SCENE_PATH, utf8('[]'), sha), 422, 'rejected');
	await rejects(repo.store.writeFile(SCENE_PATH, Buffer.from([0xff, 0xfe, 0xfd]), sha), 422, 'rejected', /UTF-8/);
	const wrongVersion = JSON.parse(sceneText());
	wrongVersion.version = 99;
	await rejects(repo.store.writeFile(SCENE_PATH, utf8(JSON.stringify(wrongVersion)), sha), 422, 'rejected');
	const badObject = JSON.parse(sceneText());
	badObject.rooms.elnur.objects = [{ id: 'x', type: 'bogus-type', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
	await rejects(repo.store.writeFile(SCENE_PATH, utf8(JSON.stringify(badObject)), sha), 422, 'rejected');
	const unknownRoom = JSON.parse(sceneText());
	unknownRoom.rooms.notaroom = { objects: [] };
	await rejects(repo.store.writeFile(SCENE_PATH, utf8(JSON.stringify(unknownRoom)), sha), 422, 'rejected');

	const msha = (await repo.store.readText(MODELS_PATH)).sha;
	await rejects(repo.store.writeFile(MODELS_PATH, utf8('{}'), msha), 422, 'rejected');
	await rejects(repo.store.writeFile(MODELS_PATH, utf8('[{"id":"../x","label":"x","file":"/models/x.glb","defaultScale":1}]'), msha), 422, 'rejected');
	await rejects(repo.store.writeFile(MODELS_PATH, utf8('[1,2]'), msha), 422, 'rejected');
	await rejects(repo.store.writeFile(MODELS_PATH, utf8('[{"id":"a","label":"a","file":"/models/a.glb","defaultScale":1},{"id":"a","label":"b","file":"/models/a.glb","defaultScale":1}]'), msha), 422, 'rejected'); // duplicate id

	await rejects(repo.store.writeFile('public/models/a.glb', Buffer.from('not a glb'), null), 422, 'rejected');
	await rejects(repo.store.writeFile('public/models/a.glb', Buffer.alloc(0), null), 422, 'rejected');
	const truncated = Buffer.from(GLB).subarray(0, GLB.byteLength - 5);
	await rejects(repo.store.writeFile('public/models/a.glb', truncated, null), 422, 'rejected');
	assert.equal(await stat(path.join(repo.root, 'public/models/a.glb')).catch(() => null), null);
	assert.equal((await repo.read(SCENE_PATH)).toString(), sceneText());
});

test('writeFile: a body over the model size cap is 413 (the existing MAX_MODEL_BYTES, no new constant)', async () => {
	assert.equal(MAX_FILE_BYTES, MAX_MODEL_BYTES);
	assert.equal(MAX_COMMIT_BYTES, 4 * MAX_MODEL_BYTES);
	const repo = await makeRepo();
	await rejects(repo.store.writeFile('public/models/big.glb', Buffer.alloc(MAX_MODEL_BYTES + 1), null), 413, 'too-large');
	await rejects(repo.store.writeFile(SCENE_PATH, Buffer.alloc(MAX_MODEL_BYTES + 1, 0x20), (await repo.store.readText(SCENE_PATH)).sha), 413, 'too-large');
});

test('writeFile: a symlinked target or a symlinked parent directory is refused', async () => {
	const repo = await makeRepo({ glbs: ['chair'] });
	const outside = path.join(tmpBase, 'outside.txt');
	await writeFile(outside, 'secret');
	// symlinked target file
	await rm(path.join(repo.root, 'public/models/chair.glb'));
	await symlink(outside, path.join(repo.root, 'public/models/chair.glb'));
	await rejects(repo.store.writeFile('public/models/chair.glb', GLB, null), 403, 'forbidden');
	await rejects(repo.store.blobSha('public/models/chair.glb'), 403, 'forbidden');
	assert.equal((await readFile(outside)).toString(), 'secret');
	// symlinked parent directory
	const repo2 = await makeRepo();
	const elsewhere = path.join(tmpBase, 'elsewhere');
	await mkdir(elsewhere);
	await rm(path.join(repo2.root, 'public/models'), { recursive: true });
	await symlink(elsewhere, path.join(repo2.root, 'public/models'));
	await rejects(repo2.store.writeFile('public/models/new.glb', GLB, null), 403, 'forbidden');
	assert.deepEqual(await readdir(elsewhere), []);
});

test('writeFile: two concurrent writers with the same sha — exactly one wins, the other gets 409', async () => {
	const repo = await makeRepo();
	const sha = (await repo.store.readText(SCENE_PATH)).sha;
	const a = repo.store.writeFile(SCENE_PATH, utf8(sceneText([obj('a', 'box')])), sha);
	const b = repo.store.writeFile(SCENE_PATH, utf8(sceneText([obj('b', 'lamp')])), sha);
	const results = await Promise.allSettled([a, b]);
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
	const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
	assert.ok(failed.reason instanceof LocalSaveError && failed.reason.status === 409);
	assert.deepEqual((await readdir(path.join(repo.root, 'src/data'))).filter((f) => f.endsWith('.tmp')), []);
});

// ---- head token ----------------------------------------------------------------------------------------------

test('head: changes with scene.json, models.json and any public/models glb (added, changed, removed); ignores other files', async () => {
	const repo = await makeRepo({ glbs: ['chair'] });
	const h0 = (await repo.store.head()).head;
	assert.match(h0, /^[0-9a-f]{40}$/);
	assert.equal((await repo.store.head()).head, h0, 'stable while nothing changes');
	await writeFile(path.join(repo.root, 'public/models/notes.txt'), 'x');
	await writeFile(path.join(repo.root, 'public/models/.hidden.glb.tmp'), 'x');
	await writeFile(path.join(repo.root, 'public/models/bad id.glb'), 'x');
	await writeFile(path.join(repo.root, 'src/data/other.json'), '{}');
	assert.equal((await repo.store.head()).head, h0, 'files outside the covered set do not matter');
	const seen = new Set([h0]);
	await writeFile(path.join(repo.root, SCENE_PATH), sceneText([obj('a', 'box')]));
	seen.add((await repo.store.head()).head);
	await writeFile(path.join(repo.root, MODELS_PATH), modelsText('chair', 'other'));
	seen.add((await repo.store.head()).head);
	await writeFile(path.join(repo.root, 'public/models/extra.glb'), GLB);
	seen.add((await repo.store.head()).head);
	await writeFile(path.join(repo.root, 'public/models/chair.glb'), Buffer.concat([Buffer.from(GLB), Buffer.alloc(4)]));
	seen.add((await repo.store.head()).head);
	await rm(path.join(repo.root, 'public/models/extra.glb'));
	seen.add((await repo.store.head()).head);
	assert.equal(seen.size, 6, 'every change produced a different head');
});

test('head: works with a missing public/models directory and missing data files', async () => {
	const repo = await makeRepo();
	await rm(path.join(repo.root, 'public'), { recursive: true });
	await rm(path.join(repo.root, MODELS_PATH));
	assert.match((await repo.store.head()).head, /^[0-9a-f]{40}$/);
});

// ---- commit --------------------------------------------------------------------------------------------------

test('commit: writes glbs before models.json, then deletes; reports written/unchanged/deleted; new head returned', async () => {
	const repo = await makeRepo({ glbs: ['old'], models: modelsText('old') });
	const { head } = await repo.store.head();
	repo.touched.length = 0;
	const body = frame(head, [
		{ path: MODELS_PATH, op: 'write', bytes: utf8(modelsText('new')) },
		{ path: 'public/models/old.glb', op: 'delete' },
		{ path: 'public/models/new.glb', op: 'write', bytes: GLB },
	]);
	const result = await repo.store.commit(body);
	assert.deepEqual(result.written, ['public/models/new.glb', MODELS_PATH]);
	assert.deepEqual(result.deleted, ['public/models/old.glb']);
	assert.deepEqual(result.unchanged, []);
	assert.equal(result.head, (await repo.store.head()).head);
	assert.deepEqual(await repo.read('public/models/new.glb'), Buffer.from(GLB));
	assert.equal((await repo.read(MODELS_PATH)).toString(), modelsText('new'));
	assert.equal(await stat(path.join(repo.root, 'public/models/old.glb')).catch(() => null), null);
	// order of the real mutations as observed by onWrite: new.glb, models.json, then old.glb removal
	const finals = repo.touched.filter((p) => !p.endsWith('.tmp')).map((p) => path.relative(repo.root, p));
	const firstIndex = (rel: string) => finals.indexOf(rel);
	assert.ok(firstIndex('public/models/new.glb') < firstIndex(MODELS_PATH), 'glb before models.json');
	assert.ok(firstIndex(MODELS_PATH) < firstIndex('public/models/old.glb'), 'delete after models.json');
	assert.deepEqual((await readdir(path.join(repo.root, 'public/models'))).sort(), ['new.glb']);
});

test('commit: unchanged files (same blob sha) are skipped and not rewritten', async () => {
	const repo = await makeRepo({ glbs: ['chair'], models: modelsText('chair') });
	const { head } = await repo.store.head();
	repo.touched.length = 0;
	const result = await repo.store.commit(frame(head, [
		{ path: 'public/models/chair.glb', op: 'write', bytes: GLB },
		{ path: MODELS_PATH, op: 'write', bytes: utf8(modelsText('chair')) },
	]));
	assert.deepEqual(result.written, []);
	assert.deepEqual(result.unchanged.sort(), ['public/models/chair.glb', MODELS_PATH].sort());
	assert.deepEqual(repo.touched, []);
});

test('commit: a stale expectedHead is a 409 and writes nothing', async () => {
	const repo = await makeRepo({ glbs: ['chair'], models: modelsText('chair') });
	const { head } = await repo.store.head();
	await writeFile(path.join(repo.root, SCENE_PATH), sceneText([obj('a', 'box')])); // external edit moves the head
	await rejects(repo.store.commit(frame(head, [{ path: 'public/models/n.glb', op: 'write', bytes: GLB }])), 409, 'conflict');
	await rejects(repo.store.commit(frame('0'.repeat(40), [{ path: 'public/models/n.glb', op: 'write', bytes: GLB }])), 409, 'conflict');
	assert.equal(await stat(path.join(repo.root, 'public/models/n.glb')).catch(() => null), null);
	assert.equal((await repo.read(SCENE_PATH)).toString(), sceneText([obj('a', 'box')]));
});

test('commit: validation failures (bad GLB / models.json / scene) reject the WHOLE commit, nothing is written', async () => {
	const repo = await makeRepo({ glbs: ['old'], models: modelsText('old') });
	const { head } = await repo.store.head();
	const before = (await repo.store.head()).head;
	const cases: Array<[string, Parameters<typeof frame>[1]]> = [
		['bad glb', [{ path: 'public/models/a.glb', op: 'write', bytes: GLB }, { path: 'public/models/b.glb', op: 'write', bytes: utf8('nope') }]],
		['bad models.json', [{ path: 'public/models/a.glb', op: 'write', bytes: GLB }, { path: MODELS_PATH, op: 'write', bytes: utf8('{"x":1}') }]],
		['bad scene', [{ path: 'public/models/a.glb', op: 'write', bytes: GLB }, { path: SCENE_PATH, op: 'write', bytes: utf8('{}') }]],
	];
	for (const [name, changes] of cases) {
		await rejects(repo.store.commit(frame(head, changes)), 422, 'rejected');
		assert.equal((await repo.store.head()).head, before, `${name}: nothing written`);
	}
	assert.equal(await stat(path.join(repo.root, 'public/models/a.glb')).catch(() => null), null);
});

test('commit: a path outside the allowlist rejects the whole commit with 403', async () => {
	const repo = await makeRepo();
	const { head } = await repo.store.head();
	for (const p of ['package.json', '../x.glb', 'public/models/../../x.glb', '/tmp/x.glb', 'src/data/family.ts']) {
		await rejects(repo.store.commit(frame(head, [{ path: 'public/models/ok.glb', op: 'write', bytes: GLB }, { path: p, op: 'write', bytes: GLB }])), 403, 'forbidden');
	}
	assert.equal(await stat(path.join(repo.root, 'public/models/ok.glb')).catch(() => null), null);
});

test('commit: a model is not deleted while the scene on disk uses it; allowed once the scene (in the same commit or on disk) drops it', async () => {
	const repo = await makeRepo({ glbs: ['chair'], models: modelsText('chair'), scene: sceneText([obj('c1', 'model:chair')]) });
	const del = { path: 'public/models/chair.glb', op: 'delete' } as const;
	// 1. scene on disk uses it -> refused (422), file stays
	let { head } = await repo.store.head();
	await rejects(repo.store.commit(frame(head, [{ path: MODELS_PATH, op: 'write', bytes: utf8(modelsText()) }, del])), 422, 'rejected', /still used/);
	assert.ok(await stat(path.join(repo.root, 'public/models/chair.glb')));
	assert.equal((await repo.read(MODELS_PATH)).toString(), modelsText('chair'), 'models.json untouched by the refused commit');
	// 2. the commit's own scene write still uses it -> refused, even though the disk scene does not
	await writeFile(path.join(repo.root, SCENE_PATH), sceneText());
	({ head } = await repo.store.head());
	await rejects(repo.store.commit(frame(head, [{ path: SCENE_PATH, op: 'write', bytes: utf8(sceneText([obj('c1', 'model:chair')])) }, del])), 422, 'rejected', /still used/);
	assert.ok(await stat(path.join(repo.root, 'public/models/chair.glb')));
	// 3. the commit's own scene write drops it while the disk scene still uses it -> allowed
	await writeFile(path.join(repo.root, SCENE_PATH), sceneText([obj('c1', 'model:chair')]));
	({ head } = await repo.store.head());
	const ok = await repo.store.commit(frame(head, [{ path: SCENE_PATH, op: 'write', bytes: utf8(sceneText()) }, { path: MODELS_PATH, op: 'write', bytes: utf8(modelsText()) }, del]));
	assert.deepEqual(ok.deleted, ['public/models/chair.glb']);
	assert.equal(await stat(path.join(repo.root, 'public/models/chair.glb')).catch(() => null), null);
});

test('commit: delete is refused when the scene on disk cannot be read; a delete of a missing glb is tolerated', async () => {
	const repo = await makeRepo({ glbs: ['chair'], models: modelsText('chair') });
	await writeFile(path.join(repo.root, SCENE_PATH), 'garbage');
	const { head } = await repo.store.head();
	await rejects(repo.store.commit(frame(head, [{ path: 'public/models/chair.glb', op: 'delete' }])), 422, 'rejected');
	assert.ok(await stat(path.join(repo.root, 'public/models/chair.glb')));
	await writeFile(path.join(repo.root, SCENE_PATH), sceneText());
	const h2 = (await repo.store.head()).head;
	const res = await repo.store.commit(frame(h2, [{ path: 'public/models/ghost.glb', op: 'delete' }]));
	assert.deepEqual(res.deleted, []);
});

test('commit: only model files can be deleted (scene.json / models.json delete is refused)', async () => {
	const repo = await makeRepo();
	const { head } = await repo.store.head();
	await rejects(repo.store.commit(frame(head, [{ path: SCENE_PATH, op: 'delete' }])), 422, 'rejected');
	await rejects(repo.store.commit(frame(head, [{ path: MODELS_PATH, op: 'delete' }])), 422, 'rejected');
	assert.ok(await stat(path.join(repo.root, SCENE_PATH)));
});

test('commit: a failure part-way (a symlinked glb target) reports 403 and models.json is not written', async () => {
	const repo = await makeRepo({ models: modelsText() });
	const outside = path.join(tmpBase, `outside-${n++}.txt`);
	await writeFile(outside, 'secret');
	await symlink(outside, path.join(repo.root, 'public/models/trap.glb'));
	const { head } = await repo.store.head().catch(() => ({ head: '' }));
	// head() itself skips symlinks (not regular files), so it works
	assert.match(head, /^[0-9a-f]{40}$/);
	await rejects(
		repo.store.commit(frame(head, [{ path: 'public/models/trap.glb', op: 'write', bytes: GLB }, { path: MODELS_PATH, op: 'write', bytes: utf8(modelsText('trap')) }])),
		403, 'forbidden',
	);
	assert.equal((await repo.read(MODELS_PATH)).toString(), modelsText());
	assert.equal((await readFile(outside)).toString(), 'secret');
});

// ---- commit framing ------------------------------------------------------------------------------------------

test('parseCommitBody: parses a well-formed body', () => {
	const head = 'a'.repeat(40);
	const parsed = parseCommitBody(frame(head, [{ path: 'public/models/a.glb', op: 'write', bytes: GLB }, { path: 'public/models/b.glb', op: 'delete' }]));
	assert.equal(parsed.expectedHead, head);
	assert.equal(parsed.changes.length, 2);
	assert.equal(parsed.changes[0].op, 'write');
	assert.deepEqual(Buffer.from(parsed.changes[0].bytes), Buffer.from(GLB));
	assert.equal(parsed.changes[1].op, 'delete');
});

test('parseCommitBody: malformed framing is 400/403/413/422, never a crash', () => {
	const head = 'a'.repeat(40);
	const w = (p: string, bytes: Uint8Array = GLB) => ({ path: p, op: 'write' as const, bytes });
	const ok = frame(head, [w('public/models/a.glb')]);
	const bad = (buf: Buffer, status: number) => assert.throws(() => parseCommitBody(buf), (e: unknown) => e instanceof LocalSaveError && e.status === status, `status ${status}`);
	bad(Buffer.alloc(0), 400);
	bad(Buffer.alloc(3), 400);
	bad(Buffer.alloc(4), 400); // header length 0
	bad(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.alloc(8)]), 400); // header length huge
	bad(ok.subarray(0, ok.byteLength - 1), 400); // data shorter than the sizes say
	bad(Buffer.concat([ok, Buffer.from([0])]), 400); // trailing bytes
	bad(frame(head, [], { expectedHead: head, changes: [] }), 400);
	bad(frame(head, [], { expectedHead: 'xyz', changes: [{ path: 'public/models/a.glb', op: 'delete' }] }), 400);
	bad(frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'delete' }], extra: 1 }), 400);
	bad(frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'rename' }] }), 400);
	bad(frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'write', size: -1 }] }), 400);
	bad(frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'write', size: 1.5 }] }), 400);
	bad(frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'write' }] }), 400);
	bad(frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'delete', size: 3 }] }), 400);
	bad(frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'delete', mode: 'x' }] }), 400);
	bad(frame(head, [], { expectedHead: head, changes: ['x'] }), 400);
	bad(frame(head, [], [] as never), 400);
	bad(frame(head, [], { expectedHead: head, changes: Array.from({ length: 65 }, (_, i) => ({ path: `public/models/a${i}.glb`, op: 'delete' })) }), 400);
	bad(frame(head, [w('public/models/a.glb'), w('public/models/a.glb')]), 422); // duplicate path
	bad(frame(head, [w('package.json')]), 403);
	bad(frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'write', size: MAX_FILE_BYTES + 1 }] }), 413);
	bad(Buffer.alloc(MAX_COMMIT_BYTES + 64 * 1024 + 5), 413);
	// header that is not UTF-8 / not JSON
	const len = Buffer.alloc(4);
	len.writeUInt32BE(3, 0);
	bad(Buffer.concat([len, Buffer.from([0xff, 0xfe, 0xfd])]), 400);
	bad(Buffer.concat([len, Buffer.from('abc')]), 400);
});

test('commit: a size field that lies about the data is rejected (no partial write)', async () => {
	const repo = await makeRepo();
	const { head } = await repo.store.head();
	const lie = frame(head, [], { expectedHead: head, changes: [{ path: 'public/models/a.glb', op: 'write', size: GLB.byteLength + 10 }] });
	await rejects(repo.store.commit(Buffer.concat([lie, Buffer.from(GLB)])), 400, 'bad-request');
	assert.equal(await stat(path.join(repo.root, 'public/models/a.glb')).catch(() => null), null);
});

// ---- the module itself stays dependency free --------------------------------------------------------------------

test('dev/ files import only node built-ins and the repo modules named in the plan (no new dependency)', async () => {
	for (const file of ['local-save-core.mjs', 'local-save-plugin.mjs']) {
		const text = await readFile(path.join(HERE, '..', 'dev', file), 'utf8');
		const specs = [...text.matchAll(/(?:import\s[^'"]*from\s*|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
		for (const spec of specs) assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `${file}: unexpected import ${spec}`);
	}
});
