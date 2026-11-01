// Tests for dev/local-save-plugin.mjs: the real middleware driven with mock requests (no socket, no dev server),
// including the request guard as the HTTP layer applies it, status codes, response headers, and the `hotUpdate`
// hook that suppresses the reload for files the endpoint wrote. Temp repo roots live in tests/.tmp-local-save-plugin-*.
// Run: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import localSavePlugin from '../dev/local-save-plugin.mjs';
import { gitBlobSha, MAX_FILE_BYTES } from '../dev/local-save-core.mjs';
import { MAX_MODEL_BYTES } from '../src/scripts/admin/model-file.ts';
import { emptyScene, serializeScene } from '../src/data/scene.ts';
import { makeBoxGlb } from './helpers/gltf-fixtures.ts';
import { makeHarness, ORIGIN, PORT } from './helpers/local-save-http.ts';
import type { Harness } from './helpers/local-save-http.ts';

const SLUGS = ['elnur', 'sabina', 'nadir', 'chinara', 'alibala', 'elkhan', 'fazil'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB = makeBoxGlb();
const SCENE = 'src/data/scene.json';
const MODELS = 'src/data/models.json';
const sceneText = (type?: string) => {
	const scene = emptyScene(SLUGS);
	if (type) scene.rooms.elnur.objects = [{ id: 'o1', type, position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] }] as never;
	return serializeScene(scene);
};

let base = '';
let n = 0;
before(async () => {
	base = await mkdtemp(path.join(HERE, '.tmp-local-save-plugin-'));
});
after(async () => {
	if (base) await rm(base, { recursive: true, force: true });
});

async function makeRepo() {
	const root = path.join(base, `repo${n++}`);
	await mkdir(path.join(root, 'src/data'), { recursive: true });
	await mkdir(path.join(root, 'public/models'), { recursive: true });
	await writeFile(path.join(root, SCENE), sceneText());
	await writeFile(path.join(root, MODELS), '[]\n');
	return root;
}
async function makeServer() {
	const root = await makeRepo();
	const h = await makeHarness({ root });
	await h.ready();
	return { root, h };
}
const G = { 'x-alishly-local-save': '1' };
const json = async (res: Response) => (await res.json()) as any;

// ---- routing and responses ----------------------------------------------------------------------------------

test('plugin: ping works without the custom header and answers JSON with no-store, nosniff and no CORS headers', async () => {
	const { h } = await makeServer();
	const res = await h.fetch('/__local-save/ping');
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, service: 'alishly-local-save', version: 1 });
	assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
	assert.equal(res.headers.get('cache-control'), 'no-store');
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('plugin: requests outside /__local-save/ fall through to next()', async () => {
	const { h } = await makeServer();
	for (const url of ['/admin', '/', '/__local-savex/ping', '/_local-save/ping']) {
		const res = await h.fetch(url);
		assert.equal(res.status, 599, url);
	}
});

test('plugin: unknown route is 404, wrong method is 405 with Allow', async () => {
	const { h } = await makeServer();
	assert.equal((await h.fetch('/__local-save/nothing', { headers: G })).status, 404);
	const post = await h.fetch('/__local-save/head', { method: 'POST', headers: G });
	assert.equal(post.status, 405);
	assert.equal(post.headers.get('allow'), 'GET');
	const get = await h.fetch('/__local-save/commit', { headers: G });
	assert.equal(get.status, 405);
	assert.equal(get.headers.get('allow'), 'POST');
	for (const method of ['DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
		const res = await h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE)}`, { method, headers: { ...G, 'content-type': 'application/json' } });
		assert.ok([405, 400, 403].includes(res.status), `${method} -> ${res.status}`);
	}
});

test('plugin: GET file / blob-sha / head return what is on disk', async () => {
	const { h, root } = await makeServer();
	const file = await json(await h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE)}`, { headers: G }));
	assert.equal(file.text, sceneText());
	assert.equal(file.sha, gitBlobSha(Buffer.from(sceneText())));
	const blob = await json(await h.fetch(`/__local-save/blob-sha?path=${encodeURIComponent('public/models/none.glb')}`, { headers: G }));
	assert.equal(blob.sha, null);
	const head = await json(await h.fetch('/__local-save/head', { headers: G }));
	assert.match(head.head, /^[0-9a-f]{40}$/);
	assert.equal((await readdir(root)).includes('package.json'), false);
});

test('plugin: path parameter must be present exactly once; traversal / absolute / encoded paths are 403', async () => {
	const { h } = await makeServer();
	assert.equal((await h.fetch('/__local-save/file', { headers: G })).status, 400);
	assert.equal((await h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE)}&path=${encodeURIComponent(MODELS)}`, { headers: G })).status, 400);
	for (const p of ['../package.json', '/etc/passwd', 'src/data/../../package.json', 'public/models/..%2f..%2fx.glb', '%2e%2e/package.json', 'package.json', '.env', 'public/models/a.glb']) {
		const res = await h.fetch(`/__local-save/file?path=${encodeURIComponent(p)}`, { headers: G });
		assert.equal(res.status, 403, `${p} -> ${res.status}`);
	}
	// double-encoded: the server decodes once, the result is still not an allowlisted path
	const res = await h.fetch(`/__local-save/file?path=${encodeURIComponent(encodeURIComponent(SCENE))}`, { headers: G });
	assert.equal(res.status, 403);
});

// ---- guard through HTTP -------------------------------------------------------------------------------------

test('plugin guard: reads need the custom header; writes additionally need the exact Origin', async () => {
	const { h } = await makeServer();
	const url = `/__local-save/file?path=${encodeURIComponent(SCENE)}`;
	assert.equal((await h.fetch(url)).status, 403, 'no custom header');
	assert.equal((await h.fetch('/__local-save/head')).status, 403, 'no custom header (head)');
	assert.equal((await h.fetch(url, { headers: { 'x-alishly-local-save': '0' } })).status, 403);
	assert.equal((await h.fetch(url, { headers: G })).status, 200);
});

test('plugin guard: a PUT without the custom header, with a wrong Origin, without Origin or with a wrong content type never writes', async () => {
	const { h, root } = await makeServer();
	const before = await readFile(path.join(root, SCENE), 'utf8');
	const sha = gitBlobSha(Buffer.from(before));
	const url = `/__local-save/file?path=${encodeURIComponent(SCENE)}&sha=${sha}`;
	const body = Buffer.from(sceneText('box'));
	const okHeaders = { host: `localhost:${PORT}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-alishly-local-save': '1', 'content-type': 'application/json' };
	const bad: Array<[string, Record<string, string>, number]> = [
		['no custom header', { ...okHeaders, 'x-alishly-local-save': '' }, 403],
		['wrong Origin port', { ...okHeaders, origin: 'http://localhost:4322' }, 403],
		['evil Origin', { ...okHeaders, origin: 'http://evil.com' }, 403],
		['null Origin', { ...okHeaders, origin: 'null' }, 403],
		['wrong Host', { ...okHeaders, host: 'evil.com', origin: 'http://evil.com' }, 403],
		['cross-site', { ...okHeaders, 'sec-fetch-site': 'cross-site' }, 403],
		['text/plain', { ...okHeaders, 'content-type': 'text/plain;charset=UTF-8' }, 415],
		['form', { ...okHeaders, 'content-type': 'application/x-www-form-urlencoded' }, 415],
		['octet for a json file', { ...okHeaders, 'content-type': 'application/octet-stream' }, 415],
		['no content type', { host: okHeaders.host, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-alishly-local-save': '1' }, 415],
	];
	for (const [name, headers, status] of bad) {
		const res = await h.raw('PUT', url, headers, body);
		assert.equal(res.status, status, name);
	}
	const noOrigin: Record<string, string> = { ...okHeaders };
	delete noOrigin.origin;
	assert.equal((await h.raw('PUT', url, noOrigin, body)).status, 403, 'no Origin');
	assert.equal(await readFile(path.join(root, SCENE), 'utf8'), before, 'file untouched by every refused request');
	// and the same request with correct headers works
	assert.equal((await h.raw('PUT', url, okHeaders, body)).status, 200);
	assert.equal(await readFile(path.join(root, SCENE), 'utf8'), body.toString());
});

test('plugin guard: a glb PUT needs application/octet-stream; a commit needs application/octet-stream', async () => {
	const { h, root } = await makeServer();
	const put = (type: string | undefined) =>
		h.fetch(`/__local-save/file?path=${encodeURIComponent('public/models/a.glb')}`, { method: 'PUT', headers: { ...G, ...(type ? { 'content-type': type } : {}) }, body: GLB });
	assert.equal((await put('application/json')).status, 415);
	assert.equal((await put('model/gltf-binary')).status, 415);
	assert.equal((await put(undefined)).status, 415);
	assert.equal((await readdir(path.join(root, 'public/models'))).length, 0);
	assert.equal((await put('application/octet-stream')).status, 200);
	assert.deepEqual(await readFile(path.join(root, 'public/models/a.glb')), Buffer.from(GLB));
	const commit = await h.fetch('/__local-save/commit', { method: 'POST', headers: { ...G, 'content-type': 'application/json' }, body: new Uint8Array(8) });
	assert.equal(commit.status, 415);
});

test('plugin: PUT with a stale sha is 409 conflict, invalid content 422, create-only on an existing file 409', async () => {
	const { h, root } = await makeServer();
	const put = (body: string, sha?: string) =>
		h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE)}${sha ? `&sha=${sha}` : ''}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/json' }, body: new TextEncoder().encode(body) });
	const stale = await put(sceneText('box'), '1'.repeat(40));
	assert.equal(stale.status, 409);
	assert.equal((await json(stale)).error.kind, 'conflict');
	assert.equal((await put(sceneText('box'))).status, 409, 'create-only on existing');
	const sha = gitBlobSha(Buffer.from(sceneText()));
	const bad = await put('{"version":99}', sha);
	assert.equal(bad.status, 422);
	assert.equal((await json(bad)).error.kind, 'rejected');
	assert.equal((await put(sceneText('box'), 'not-a-sha')).status, 400);
	assert.equal(await readFile(path.join(root, SCENE), 'utf8'), sceneText());
});

test('plugin: bodies over the model cap are 413 (declared and streamed), and the connection is marked for closing', async () => {
	const { h, root } = await makeServer();
	const url = `/__local-save/file?path=${encodeURIComponent('public/models/big.glb')}`;
	const headers = { host: `localhost:${PORT}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-alishly-local-save': '1', 'content-type': 'application/octet-stream' };
	const big = Buffer.alloc(MAX_MODEL_BYTES + 1);
	const declared = await h.raw('PUT', url, headers, big);
	assert.equal(declared.status, 413);
	assert.equal(declared.headers.get('connection'), 'close');
	assert.equal((await json(declared)).error.kind, 'too-large');
	// a lying Content-Length: smaller declared, bigger streamed
	const lying = await h.raw('PUT', url, { ...headers, 'content-length': '10' }, big);
	assert.equal(lying.status, 413);
	assert.equal(MAX_FILE_BYTES, MAX_MODEL_BYTES);
	assert.deepEqual(await readdir(path.join(root, 'public/models')), []);
});

test('plugin: a model PUT then GET blob-sha round-trips; the head covers the new glb', async () => {
	const { h } = await makeServer();
	const head0 = (await json(await h.fetch('/__local-save/head', { headers: G }))).head;
	const res = await h.fetch(`/__local-save/file?path=${encodeURIComponent('public/models/chair.glb')}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/octet-stream' }, body: GLB });
	assert.equal(res.status, 200);
	const body = await json(res);
	assert.equal(body.sha, gitBlobSha(Buffer.from(GLB)));
	assert.notEqual(body.head, head0);
	const blob = await json(await h.fetch(`/__local-save/blob-sha?path=${encodeURIComponent('public/models/chair.glb')}`, { headers: G }));
	assert.equal(blob.sha, body.sha);
});

test('plugin: errors never leak absolute server paths or stack traces', async () => {
	const { h, root } = await makeServer();
	const responses = [
		await h.fetch(`/__local-save/file?path=${encodeURIComponent('../../etc/passwd')}`, { headers: G }),
		await h.fetch(`/__local-save/file?path=${encodeURIComponent('public/models/x.glb')}`, { headers: G }),
		await h.fetch(`/__local-save/file?path=${encodeURIComponent('src/data/other.json')}`, { headers: G }),
		await h.fetch('/__local-save/head'),
	];
	for (const res of responses) {
		const text = await res.text();
		assert.ok(!text.includes(root) && !text.includes('/home/') && !/\bat \w+.*\(/.test(text), text);
	}
});

// ---- fail closed / build ------------------------------------------------------------------------------------

test('plugin: does not register the endpoint when the dev server is reachable beyond localhost', async () => {
	for (const serverConfig of [{ host: true }, { host: '0.0.0.0' }, { host: '192.168.1.5' }, { allowedHosts: true }]) {
		const root = await makeRepo();
		const h = await makeHarness({ root, serverConfig });
		assert.ok(h.logs.some((l) => l.level === 'warn' && /disabled/.test(l.text)), JSON.stringify(serverConfig));
		assert.ok(!h.logs.some((l) => /endpoint ready/.test(l.text)));
	}
	// loopback hosts are fine
	for (const serverConfig of [{}, { host: 'localhost' }, { host: '127.0.0.1' }, { host: false }]) {
		const root = await makeRepo();
		const h = await makeHarness({ root, serverConfig: serverConfig as never });
		assert.ok(h.logs.some((l) => /endpoint ready/.test(l.text)), JSON.stringify(serverConfig));
	}
});

test('plugin: apply is "serve" (never part of `astro build`) and the factory itself loads nothing from src/', async () => {
	const plugin = localSavePlugin() as any;
	assert.equal(plugin.apply, 'serve');
	assert.equal(plugin.name, 'alishly-local-save');
	assert.equal(typeof plugin.configureServer, 'function');
	// configureServer is a no-op if it is ever called for a non-serve command
	const logs: string[] = [];
	const used: unknown[] = [];
	plugin.configureServer({ config: { command: 'build', root: '/nonexistent', logger: { info: (s: string) => logs.push(s), warn: () => {}, error: () => {} }, server: {} }, middlewares: { use: (f: unknown) => used.push(f) } });
	assert.deepEqual(used, []);
	assert.deepEqual(logs, []);
});

// ---- hotUpdate -----------------------------------------------------------------------------------------------

function makeEnv(name: string) {
	const invalidated: unknown[] = [];
	const evaluatedInvalidated: unknown[] = [];
	const env = {
		name,
		moduleGraph: {
			invalidateModule(mod: { id: string }, seen: Set<unknown>, _ts: number, soft: boolean) {
				assert.equal(soft, true, 'soft invalidation');
				seen.add(mod);
				invalidated.push(mod);
			},
		},
		runner: {
			evaluatedModules: {
				getModuleById: (id: string) => ({ cachedFor: id }),
				invalidateModule: (m: unknown) => evaluatedInvalidated.push(m),
			},
		},
	};
	return { env, invalidated, evaluatedInvalidated };
}

test('hotUpdate: order "pre"; a file the endpoint just wrote is invalidated and its HMR event swallowed ([])', async () => {
	const { h, root } = await makeServer();
	const hook = (h.plugin as any).hotUpdate;
	assert.equal(hook.order, 'pre');
	const scenePath = path.join(root, SCENE).split(path.sep).join('/');
	const sha = gitBlobSha(Buffer.from(sceneText()));
	// nothing written yet -> a hand edit falls through (undefined)
	const mod = { id: scenePath };
	const probe = makeEnv('ssr');
	assert.equal(hook.handler.call({ environment: probe.env }, { file: scenePath, modules: [mod], timestamp: 1 }), undefined);
	assert.equal(probe.invalidated.length, 0);
	// write through the endpoint
	const res = await h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE)}&sha=${sha}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/json' }, body: new TextEncoder().encode(sceneText('box')) });
	assert.equal(res.status, 200);
	for (const name of ['ssr', 'client']) {
		const e = makeEnv(name);
		const out = hook.handler.call({ environment: e.env }, { file: scenePath, modules: [mod], timestamp: 2 });
		assert.deepEqual(out, [], `${name}: event swallowed`);
		assert.deepEqual(e.invalidated, [mod], `${name}: module invalidated`);
		assert.equal(e.evaluatedInvalidated.length, 1, `${name}: runner cache invalidated`);
	}
	// a different file is untouched
	const other = path.join(root, 'src/data/family.ts').split(path.sep).join('/');
	const e2 = makeEnv('ssr');
	assert.equal(hook.handler.call({ environment: e2.env }, { file: other, modules: [{ id: other }], timestamp: 3 }), undefined);
	assert.equal(e2.invalidated.length, 0);
	assert.ok(h.logs.some((l) => /no reload for scene\.json/.test(l.text)));
});

test('hotUpdate: models.json and glb writes are recognised too; a rejected write marks nothing', async () => {
	const { h, root } = await makeServer();
	const hook = (h.plugin as any).hotUpdate;
	const norm = (rel: string) => path.join(root, rel).split(path.sep).join('/');
	// a refused PUT (bad content) must not mark the file
	const refused = await h.fetch(`/__local-save/file?path=${encodeURIComponent(MODELS)}&sha=${gitBlobSha(Buffer.from('[]\n'))}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/json' }, body: new TextEncoder().encode('{}') });
	assert.equal(refused.status, 422);
	assert.equal(hook.handler.call({ environment: makeEnv('client').env }, { file: norm(MODELS), modules: [{ id: 'm' }], timestamp: 1 }), undefined, 'refused write marks nothing');
	const ok = await h.fetch(`/__local-save/file?path=${encodeURIComponent(MODELS)}&sha=${gitBlobSha(Buffer.from('[]\n'))}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/json' }, body: new TextEncoder().encode('[]\n\n') });
	assert.equal(ok.status, 200);
	assert.deepEqual(hook.handler.call({ environment: makeEnv('client').env }, { file: norm(MODELS), modules: [{ id: 'm' }], timestamp: 2 }), []);
	await h.fetch(`/__local-save/file?path=${encodeURIComponent('public/models/z.glb')}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/octet-stream' }, body: GLB });
	assert.deepEqual(hook.handler.call({ environment: makeEnv('client').env }, { file: norm('public/models/z.glb'), modules: [], timestamp: 3 }), [], 'glb with no modules is still swallowed');
});

test('hotUpdate: the mark expires — a hand edit after the TTL reloads as before', async (t) => {
	const { h, root } = await makeServer();
	const hook = (h.plugin as any).hotUpdate;
	const scenePath = path.join(root, SCENE).split(path.sep).join('/');
	t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
	const sha = gitBlobSha(Buffer.from(sceneText()));
	await h.fetch(`/__local-save/file?path=${encodeURIComponent(SCENE)}&sha=${sha}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/json' }, body: new TextEncoder().encode(sceneText('box')) });
	assert.deepEqual(hook.handler.call({ environment: makeEnv('ssr').env }, { file: scenePath, modules: [{ id: 'x' }], timestamp: 1 }), []);
	t.mock.timers.tick(5001);
	assert.equal(hook.handler.call({ environment: makeEnv('ssr').env }, { file: scenePath, modules: [{ id: 'x' }], timestamp: 2 }), undefined);
});

// A hand edit is not tested live (needs the user); see tester-r1.md.
