// Round-2 tests for the dev-only local save: behaviour added by the fix round — probeLocal messages (dev never falls
// back to GitHub), head()/blobSha with a .glb over the upload cap, per-request validators (injected, and through a
// mock Vite SSR runner with fallback), 500 text without absolute paths, stale-temp sweep, upload idle timeout.
// main.ts itself (probeDevBackend / guarded / useDiskLayout) is DOM + import.meta.env code and is NOT Node-testable;
// it is covered by the browser pass in tester-r2.md. Temp repo roots: tests/.tmp-local-save-r2-*, removed in after().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import localSavePlugin from '../dev/local-save-plugin.mjs';
import { LocalSaveError, createLocalSave, gitBlobSha, SCENE_PATH, MODELS_PATH } from '../dev/local-save-core.mjs';
import { probeLocal, pingLocal, LOCAL_WORDING } from '../src/scripts/admin/local-client.ts';
import { GITHUB_WORDING } from '../src/scripts/admin/backend.ts';
import { MAX_MODEL_BYTES, validateGlb } from '../src/scripts/admin/model-file.ts';
import { emptyScene, serializeScene, validateScene, parseScene, parseModels, modelIdOf } from '../src/data/scene.ts';
import { makeBoxGlb } from './helpers/gltf-fixtures.ts';
import { makeHarness, ORIGIN, PORT } from './helpers/local-save-http.ts';

const SLUGS = ['elnur', 'sabina', 'nadir', 'chinara', 'alibala', 'elkhan', 'fazil'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB = makeBoxGlb();
const G = { 'x-alishly-local-save': '1' };
const sceneText = (slugs: readonly string[] = SLUGS) => serializeScene(emptyScene(slugs));

let base = '';
let n = 0;
before(async () => {
	base = await mkdtemp(path.join(HERE, '.tmp-local-save-r2-'));
});
after(async () => {
	if (base) {
		// a test may have left a directory read-only
		await chmod(base, 0o755).catch(() => {});
		await rm(base, { recursive: true, force: true });
	}
});

async function makeRepo(slugs: readonly string[] = SLUGS) {
	const root = path.join(base, `repo${n++}`);
	await mkdir(path.join(root, 'src/data'), { recursive: true });
	await mkdir(path.join(root, 'public/models'), { recursive: true });
	await writeFile(path.join(root, SCENE_PATH), sceneText(slugs));
	await writeFile(path.join(root, MODELS_PATH), '[]\n');
	return root;
}
const gitSha = (file: string) => execFileSync('git', ['hash-object', file]).toString().trim();
const stub = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---- probeLocal: the dev client never silently falls back to GitHub ----------------------------------------------

test('probeLocal: ok only for HTTP 200 + the right service; pingLocal stays a boolean wrapper', async () => {
	const good = stub(200, { ok: true, service: 'alishly-local-save', version: 1 });
	assert.deepEqual(await probeLocal({ fetch: good }), { ok: true });
	assert.equal(await pingLocal({ fetch: good }), true);
	assert.equal(await pingLocal({ fetch: stub(500, {}) }), false);
});

test('probeLocal: every failure is {ok:false} with a message that says why and ends with "Nothing was saved."', async () => {
	const cases: Array<[string, Parameters<typeof probeLocal>[0], RegExp]> = [
		['unreachable', { fetch: async () => { throw new TypeError('fetch failed'); } }, /did not answer.*npm run dev/s],
		['hangs (timeout)', { timeoutMs: 20, fetch: (_u: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))) }, /did not answer/],
		['404 with Astro html (plugin absent)', { fetch: stub(404, '<html>not found</html>') }, /no \/__local-save\/ endpoint.*Restart `npm run dev`/s],
		['403 with the server reason', { fetch: stub(403, { error: { kind: 'forbidden', message: 'Host is not allowed.' } }) }, /refused the request \(Host is not allowed\.\).*http:\/\/localhost:<port>\/admin/s],
		['500 with the server message', { fetch: stub(500, { error: { kind: 'internal', message: 'The local save failed to load; see the dev server log.' } }) }, /problem \(The local save failed to load.*\) \(HTTP 500\).*dev server log.*Restart/s],
		['500 without a body', { fetch: stub(500, '') }, /HTTP 500/],
		['200 but another service', { fetch: stub(200, { ok: true, service: 'vite' }) }, /unexpected answer.*another server/s],
		['200 but html', { fetch: stub(200, '<html></html>') }, /unexpected answer/],
	];
	for (const [name, options, re] of cases) {
		const r = await probeLocal(options);
		assert.equal(r.ok, false, name);
		if (r.ok) continue;
		assert.match(r.message, re, name);
		assert.match(r.message, /Nothing was saved\.$/, name);
		assert.doesNotMatch(r.message, /github/i, `${name}: no GitHub wording on a local failure`);
	}
});

test('probeLocal: never throws, never sends anything but GET ping (no token, no GitHub host)', async () => {
	const seen: Array<{ url: string; init?: RequestInit }> = [];
	await probeLocal({ fetch: async (url, init) => { seen.push({ url, init }); throw new Error('x'); } });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, '/__local-save/ping');
	assert.ok(!seen[0].init?.method || seen[0].init.method === 'GET');
	assert.equal(new Headers(seen[0].init?.headers).get('authorization'), null);
});

test('probeLocal against the real middleware is ok; against a server without the plugin (fall-through 599 path) a 404-like answer is a failure', async () => {
	const h = await makeHarness({ root: await makeRepo() });
	await h.ready();
	assert.deepEqual(await probeLocal({ fetch: h.fetch }), { ok: true });
	// "plugin absent": Astro answers an HTML 404 for the route
	const r = await probeLocal({ fetch: async () => new Response('<!doctype html><title>404</title>', { status: 404 }) });
	assert.equal(r.ok, false);
});

test('wording: the disk modelAdded text says "write it to disk" (no "publish"); the GitHub text is unchanged', () => {
	const disk = LOCAL_WORDING.modelAdded('Chair');
	assert.match(disk, /click Save models to write it to disk/);
	assert.doesNotMatch(disk, /publish|github/i);
	assert.match(GITHUB_WORDING.modelAdded('Chair'), /publish/);
});

// ---- head() / blobSha with a .glb over the upload cap ------------------------------------------------------------

async function withHugeGlb(root: string, id = 'huge') {
	const file = path.join(root, 'public/models', `${id}.glb`);
	const big = Buffer.alloc(MAX_MODEL_BYTES + 10, 7);
	await writeFile(file, big);
	return { file, big };
}

test('head/blobSha: a .glb larger than the model cap on disk is hashed (streamed) and equals git hash-object', async () => {
	const root = await makeRepo();
	const { file } = await withHugeGlb(root);
	const store = createLocalSave({ root, slugs: SLUGS });
	const { sha } = await store.blobSha('public/models/huge.glb');
	assert.equal(sha, gitSha(file));
	const a = (await store.head()).head;
	assert.match(a, /^[0-9a-f]{40}$/);
	assert.equal((await store.head()).head, a, 'stable');
	// the head still moves when the huge file changes
	await writeFile(file, Buffer.alloc(MAX_MODEL_BYTES + 11, 7));
	assert.notEqual((await store.head()).head, a);
});

test('a huge .glb on disk does not break Save (PUT scene), Load latest (GET file/head) or commit, over HTTP; uploading one is still 413', async () => {
	const root = await makeRepo();
	await withHugeGlb(root);
	const h = await makeHarness({ root });
	await h.ready();
	const head = await h.fetch('/__local-save/head', { headers: G });
	assert.equal(head.status, 200);
	const { head: token } = await head.json();
	const blob = await h.fetch(`/__local-save/blob-sha?path=${encodeURIComponent('public/models/huge.glb')}`, { headers: G });
	assert.equal(blob.status, 200);
	const load = await h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE_PATH)}`, { headers: G });
	assert.equal(load.status, 200);
	const { sha } = await load.json();
	const next = serializeScene({ ...emptyScene(SLUGS), rooms: { ...emptyScene(SLUGS).rooms, elnur: { ...emptyScene(SLUGS).rooms.elnur, objects: [{ id: 'a', type: 'box', position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] }] as never } } });
	const put = await h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE_PATH)}&sha=${sha}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/json' }, body: new TextEncoder().encode(next) });
	assert.equal(put.status, 200);
	assert.notEqual((await put.json()).head, token);
	// the huge file itself is never served as text and an upload of that size is still refused
	const text = await h.fetch(`/__local-save/file?path=${encodeURIComponent('public/models/huge.glb')}`, { headers: G });
	assert.equal(text.status, 403);
	const up = await h.fetch(`/__local-save/file?path=${encodeURIComponent('public/models/other.glb')}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/octet-stream' }, body: new Uint8Array(MAX_MODEL_BYTES + 10) });
	assert.equal(up.status, 413);
});

// ---- injected validators ---------------------------------------------------------------------------------------

const DEFAULTS = { validateScene, parseScene, parseModels, modelIdOf, validateGlb };

test('validators/slugs given as functions are re-read for EVERY operation (a new room needs no restart)', async () => {
	const root = await makeRepo();
	let slugs: string[] = [...SLUGS];
	let calls = 0;
	const store = createLocalSave({ root, slugs: async () => slugs, validators: async () => { calls++; return DEFAULTS; } });
	const withRoom = sceneText([...SLUGS, 'newroom']);
	const sceneSha = (await store.readText(SCENE_PATH)).sha;
	await assert.rejects(store.writeFile(SCENE_PATH, Buffer.from(withRoom), sceneSha), (e: unknown) => e instanceof LocalSaveError && e.status === 422);
	slugs = [...SLUGS, 'newroom'];
	const ok = await store.writeFile(SCENE_PATH, Buffer.from(withRoom), sceneSha);
	assert.equal(ok.sha, gitBlobSha(Buffer.from(withRoom)));
	assert.ok(calls >= 3, `validators() was called per operation (got ${calls})`);
});

test('injected validateGlb / validateScene replace the static ones between two calls', async () => {
	const root = await makeRepo();
	let strict = true;
	const validators = async () => ({ ...DEFAULTS, validateGlb: (bytes: Uint8Array) => { if (strict) throw new Error('rule v1: no'); return validateGlb(bytes); } });
	const store = createLocalSave({ root, slugs: SLUGS, validators });
	await assert.rejects(store.writeFile('public/models/chair.glb', GLB, null), (e: unknown) => e instanceof LocalSaveError && e.status === 422 && /rule v1/.test(e.message));
	strict = false;
	const r = await store.writeFile('public/models/chair.glb', GLB, null);
	assert.equal(r.sha, gitBlobSha(GLB));
});

test('validators that fail to load: 500 "could not load the scene rules (see the dev server log)", cause kept server-side, nothing written, no paths', async () => {
	const root = await makeRepo();
	const store = createLocalSave({ root, slugs: SLUGS, validators: async () => { throw new Error(`boom at ${root}/src/data/scene.ts`); } });
	for (const op of [() => store.head(), () => store.readText(SCENE_PATH), () => store.blobSha(SCENE_PATH), () => store.writeFile('public/models/a.glb', GLB, null)]) {
		await assert.rejects(op(), (e: unknown) => {
			assert.ok(e instanceof LocalSaveError);
			assert.equal(e.status, 500);
			assert.match(e.message, /could not load the scene rules/);
			assert.ok(!e.message.includes(root) && !e.message.includes('boom'));
			assert.ok(e.cause instanceof Error, 'original error attached as cause');
			return true;
		});
	}
	assert.deepEqual(await readdir(path.join(root, 'public/models')), []);
});

// Plugin: validators come through server.environments.ssr.runner.import, per request; runner failure falls back.
async function runnerHarness(root: string, importImpl: (p: string) => Promise<unknown>) {
	const imported: string[] = [];
	const runner = { import: async (p: string) => { imported.push(p); return importImpl(p); } };
	const h = await makeHarness({ root, environments: { ssr: { runner } } });
	await h.ready();
	return { h, imported };
}
const REAL = {
	scene: () => import('../src/data/scene.ts'),
	file: () => import('../src/scripts/admin/model-file.ts'),
	family: () => import('../src/data/family.ts'),
};
const realFor = async (p: string) => (p.endsWith('family.ts') ? REAL.family() : p.endsWith('scene.ts') ? REAL.scene() : REAL.file());
const putScene = (h: Awaited<ReturnType<typeof makeHarness>>, text: string, sha: string) =>
	h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE_PATH)}&sha=${sha}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/json' }, body: new TextEncoder().encode(text) });

test('plugin: the scene rules are loaded through the SSR runner on every request, so a changed room list applies without a restart', async () => {
	const root = await makeRepo();
	let extra = false;
	const { h, imported } = await runnerHarness(root, async (p) => {
		const mod = await realFor(p);
		if (p.endsWith('family.ts') && extra) return { ...mod, family: [...(mod as any).family, { slug: 'newroom' }] };
		return mod;
	});
	const sha = gitBlobSha(Buffer.from(sceneText()));
	const withRoom = sceneText([...SLUGS, 'newroom']);
	assert.equal((await putScene(h, withRoom, sha)).status, 422);
	const before = imported.length;
	extra = true;
	assert.equal((await putScene(h, withRoom, sha)).status, 200);
	assert.ok(imported.length > before, 'runner.import is consulted again on the next request');
	assert.ok(imported.every((p) => p.startsWith(root)), 'resolved against the server root');
	assert.ok(imported.some((p) => p.endsWith(path.join('src', 'data', 'scene.ts'))) && imported.some((p) => p.endsWith(path.join('src', 'scripts', 'admin', 'model-file.ts'))) && imported.some((p) => p.endsWith(path.join('src', 'data', 'family.ts'))));
	assert.equal(h.logs.filter((l) => l.level !== 'info').length, 0, 'no warnings while the runner works');
});

test('plugin: a failing runner import warns in the log (naming the file, not leaking into the response) and falls back to the start-up copy', async () => {
	const root = await makeRepo();
	const { h } = await runnerHarness(root, async () => { throw new Error('Cannot find module'); });
	const sha = gitBlobSha(Buffer.from(sceneText()));
	const res = await putScene(h, sceneText(), sha); // identical content is fine (writes the same bytes)
	assert.equal(res.status, 200, 'the fallback copy validates');
	const warns = h.logs.filter((l) => l.level === 'warn');
	assert.ok(warns.length >= 1);
	assert.ok(warns.some((w) => /could not load .*through the dev server.*using the copy loaded at start-up/.test(w.text)));
	const body = JSON.stringify(await res.json());
	assert.doesNotMatch(body, /Cannot find module|runner/);
});

test('plugin: a runner without import() (missing) silently uses the fallback copies', async () => {
	const root = await makeRepo();
	const h = await makeHarness({ root, environments: { ssr: {} } });
	await h.ready();
	const sha = gitBlobSha(Buffer.from(sceneText()));
	assert.equal((await putScene(h, sceneText(), sha)).status, 200);
});

// ---- 500 text without absolute paths ---------------------------------------------------------------------------

test('commit failing part-way (EACCES): 500 names only the error code; response has no absolute path; the plugin logs the cause', async (t) => {
	if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
	const root = await makeRepo();
	const store = createLocalSave({ root, slugs: SLUGS });
	const h = await makeHarness({ root });
	await h.ready();
	const { head } = await store.head();
	const glb = Buffer.from(GLB);
	const header = Buffer.from(JSON.stringify({ expectedHead: head, changes: [{ path: 'public/models/chair.glb', op: 'write', size: glb.byteLength }] }));
	const len = Buffer.alloc(4);
	len.writeUInt32BE(header.byteLength, 0);
	const dir = path.join(root, 'public/models');
	await chmod(dir, 0o555);
	try {
		const res = await h.fetch('/__local-save/commit', { method: 'POST', headers: { ...G, 'content-type': 'application/octet-stream' }, body: Buffer.concat([len, header, glb]) });
		assert.equal(res.status, 500);
		const text = await res.text();
		assert.match(text, /Writing to disk failed part-way \(EACCES\)\. See the dev server log\./);
		assert.ok(!text.includes(root) && !text.includes(base) && !text.includes('/home/'), `no absolute path in: ${text}`);
		assert.doesNotMatch(text, /open|ENOENT|permission denied/i);
		const logged = h.logs.filter((l) => l.level === 'error').map((l) => l.text).join('\n');
		assert.match(logged, /Writing to disk failed part-way \(EACCES\)/);
		assert.match(logged, /EACCES/, 'the original error (with its message) is logged server-side');
	} finally {
		await chmod(dir, 0o755);
	}
	assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
});

test('PUT file failing with a raw fs error (EACCES): generic 500 without paths or fs messages', async (t) => {
	if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
	const root = await makeRepo();
	const h = await makeHarness({ root });
	await h.ready();
	const dir = path.join(root, 'public/models');
	await chmod(dir, 0o555);
	try {
		const res = await h.fetch('/__local-save/file?path=public%2Fmodels%2Fchair.glb', { method: 'PUT', headers: { ...G, 'content-type': 'application/octet-stream' }, body: new Uint8Array(GLB) });
		assert.equal(res.status, 500);
		const text = await res.text();
		assert.ok(!text.includes(root) && !text.includes('/home/') && !/EACCES|permission/i.test(text), text);
		assert.match(text, /dev server log/);
	} finally {
		await chmod(dir, 0o755);
	}
});

// ---- stale temp sweep ------------------------------------------------------------------------------------------

async function plant(root: string, rel: string, ageMs: number) {
	const file = path.join(root, rel);
	await writeFile(file, 'junk');
	const when = new Date(Date.now() - ageMs);
	await utimes(file, when, when);
}

test('sweepStaleTemp: removes only our own ".<name>.<12 hex>.tmp" files older than 60 s, in src/data and public/models', async () => {
	const root = await makeRepo();
	const marks: string[] = [];
	const store = createLocalSave({ root, slugs: SLUGS, onWrite: (p: string) => marks.push(p) });
	const old = ['src/data/.scene.json.0123456789ab.tmp', 'public/models/.chair.glb.ffffffffffff.tmp'];
	const keep = [
		'src/data/.scene.json.0123456789ac.tmp', // fresh (in progress)
		'src/data/.scene.json.tmp', // not our pattern
		'src/data/.notes.0123456789ab.txt', // wrong extension
		'src/data/scene.json.0123456789ab.tmp', // no leading dot
		'public/models/.chair.glb.ZZZZZZZZZZZZ.tmp', // not hex
		'public/models/.chair.glb.0123456789.tmp', // 10 hex
	];
	for (const f of old) await plant(root, f, 5 * 60_000);
	await plant(root, keep[0], 1000);
	for (const f of keep.slice(1)) await plant(root, f, 5 * 60_000);
	const removed = await store.sweepStaleTemp();
	assert.deepEqual([...removed].sort(), [...old].sort());
	for (const f of old) await assert.rejects(readFile(path.join(root, f)), { code: 'ENOENT' });
	for (const f of keep) assert.equal(await readFile(path.join(root, f), 'utf8'), 'junk', `${f} must stay`);
	assert.equal(await readFile(path.join(root, SCENE_PATH), 'utf8'), sceneText(), 'data files untouched');
	assert.ok(old.every((f) => marks.includes(path.join(root, f))), 'removals are marked via onWrite so the watcher event is not a reload');
});

test('sweepStaleTemp: does not follow symlinks / directories with a tmp-like name, and survives missing directories', async () => {
	const root = await makeRepo();
	await mkdir(path.join(root, 'src/data/.dir.0123456789ab.tmp'));
	await rm(path.join(root, 'public'), { recursive: true });
	const store = createLocalSave({ root, slugs: SLUGS });
	assert.deepEqual(await store.sweepStaleTemp(), []);
	assert.ok((await readdir(path.join(root, 'src/data'))).includes('.dir.0123456789ab.tmp'));
});

test('plugin start sweeps stale temp files once and logs them', async () => {
	const root = await makeRepo();
	await plant(root, 'src/data/.models.json.abcdefabcdef.tmp', 10 * 60_000);
	const h = await makeHarness({ root });
	await h.ready();
	for (let i = 0; i < 50 && !h.logs.some((l) => /removed stale temp files/.test(l.text)); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(h.logs.some((l) => /removed stale temp files: src\/data\/\.models\.json\.abcdefabcdef\.tmp/.test(l.text)));
	assert.deepEqual((await readdir(path.join(root, 'src/data'))).filter((f) => f.endsWith('.tmp')), []);
});

// ---- upload idle timeout ---------------------------------------------------------------------------------------

/** Drives the plugin middleware directly with a request body that never finishes. */
async function stalledUpload(t: import('node:test').TestContext, sendFirstChunk: boolean) {
	const root = await makeRepo();
	const handlers: Array<(req: unknown, res: unknown, next: () => void) => unknown> = [];
	const logger = { info() {}, warn() {}, error() {} };
	const plugin = localSavePlugin() as any;
	await plugin.configureServer({ config: { command: 'serve', root, logger, server: {} }, middlewares: { use: (fn: any) => handlers.push(fn) } });
	// let the lazy core import settle before the clock is mocked
	await handlers[0]({ url: '/__local-save/ping', method: 'GET', headers: { host: `localhost:${PORT}` }, socket: { localPort: PORT } }, { writeHead() {}, end() {}, once() {} }, () => {});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const body = new Readable({ read() {} });
	if (sendFirstChunk) body.push(Buffer.alloc(1000));
	let destroyed = false;
	const req = Object.assign(body, { method: 'PUT', url: `/__local-save/file?path=${encodeURIComponent('public/models/chair.glb')}`, socket: { localPort: PORT }, headers: { host: `localhost:${PORT}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream', 'content-length': '5000', ...G } });
	req.destroy = (() => { destroyed = true; return req; }) as never;
	const out = await new Promise<{ status: number; headers: Record<string, string | number>; text: string; destroyed: () => boolean }>((resolve) => {
		const res = Object.assign(new EventEmitter(), {
			statusCode: 0,
			headers: {} as Record<string, string | number>,
			writeHead(status: number, headers: Record<string, string | number>) { res.statusCode = status; res.headers = headers; },
			end(text: string) { resolve({ status: res.statusCode, headers: res.headers, text, destroyed: () => destroyed }); queueMicrotask(() => res.emit('finish')); },
		});
		Promise.resolve(handlers[0](req, res, () => {})).catch(() => {});
		// wait until the handler has armed its idle timer, then jump past it
		(async () => {
			for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
			t.mock.timers.tick(29_000);
			for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
			t.mock.timers.tick(1_500);
		})();
	});
	return { out, root };
}

test('upload idle timeout: a client that sends nothing for 30 s gets 408 "stalled", the connection is dropped, nothing is written', async (t) => {
	const { out, root } = await stalledUpload(t, false);
	assert.equal(out.status, 408);
	assert.match(out.text, /stalled/);
	assert.equal(out.headers.Connection, 'close');
	await new Promise((r) => setImmediate(r));
	assert.equal(out.destroyed(), true, 'req.destroy() after the answer');
	assert.deepEqual(await readdir(path.join(root, 'public/models')), []);
});

test('upload idle timeout: also fires after a first chunk (the timer is re-armed per chunk, not per request); partial data is discarded', async (t) => {
	const { out, root } = await stalledUpload(t, true);
	assert.equal(out.status, 408);
	assert.deepEqual(await readdir(path.join(root, 'public/models')), []);
});
