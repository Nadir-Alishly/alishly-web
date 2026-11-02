// Tests for src/scripts/admin/local-client.ts (the dev-only GithubClient that talks to /__local-save/), against
// (a) hand-made fetch stubs for exact request shape and error mapping, and (b) the REAL plugin middleware via the
// mock-request harness, so the client and server are exercised together, including the real saveModels flow.
// Task local-folder: the client still sends the repository paths (src/data/..., public/models/...); the server keeps all
// of it in local/, which is where these tests look. The committed canaries must never change. Temp repo roots live in
// tests/.tmp-local-client-*. Run: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalClient, fetchDiffers, pingLocal, LOCAL_BASE, LOCAL_WORDING } from '../src/scripts/admin/local-client.ts';
import { GITHUB_WORDING } from '../src/scripts/admin/backend.ts';
import { GithubError } from '../src/scripts/admin/github.ts';
import type { GithubClient } from '../src/scripts/admin/github.ts';
import { saveModels, findSavedImports, gitBlobSha as clientBlobSha, canonicalEntry, MODELS_JSON_PATH } from '../src/scripts/admin/model-ops.ts';
import { emptyScene, serializeScene } from '../src/data/scene.ts';
import { makeBoxGlb } from './helpers/gltf-fixtures.ts';
import { makeHarness } from './helpers/local-save-http.ts';
import { seedRepo, snapshotCommitted, toDisk } from './helpers/local-repo.ts';

const SLUGS = ['elnur', 'sabina', 'nadir', 'chinara', 'alibala', 'elkhan', 'fazil'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENE = 'src/data/scene.json';
const GLB = makeBoxGlb();
const sceneWith = (type?: string) => {
	const scene = emptyScene(SLUGS);
	if (type) scene.rooms.elnur.objects = [{ id: 'o1', type, position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] }] as never;
	return serializeScene(scene);
};
const modelsJson = (...ids: string[]) => `${JSON.stringify(ids.map((id) => canonicalEntry(id, id, 1)), null, '\t')}\n`;

let base = '';
let n = 0;
before(async () => {
	base = await mkdtemp(path.join(HERE, '.tmp-local-client-'));
});
after(async () => {
	if (base) await rm(base, { recursive: true, force: true });
});

async function makeBackend(opts: { scene?: string; models?: string; glbs?: string[] } = {}) {
	const root = path.join(base, `repo${n++}`);
	const seeded = await seedRepo(root, { scene: opts.scene ?? sceneWith(), models: opts.models ?? modelsJson(...(opts.glbs ?? [])), glbs: opts.glbs });
	const baseline = await seeded.snapshot();
	const h = await makeHarness({ root });
	await h.ready();
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const recording = (url: string, init?: RequestInit) => {
		requests.push({ url, init });
		return h.fetch(url, init);
	};
	const client = createLocalClient({ fetch: recording });
	/** `rel` is a wire path; the file is read from local/. */
	const abs = (rel: string) => path.join(root, toDisk(rel));
	return { root, h, client, requests, abs, read: (rel: string) => readFile(abs(rel)), committedUnchanged: async () => assert.deepEqual(await snapshotCommitted(root), baseline, 'src/data and public/models are byte-identical') };
}
/** Disk location (under local/) of a wire path in the temp repo `root`. */
const local = (root: string, rel: string) => path.join(root, toDisk(rel));
const failsWith = (promise: Promise<unknown>, kind: string, status?: number) =>
	assert.rejects(promise, (e: unknown) => e instanceof GithubError && e.kind === kind && (status === undefined || e.status === status), `expected GithubError ${kind}${status ? ' ' + status : ''}`);
const stub = (status: number, body: unknown, contentType = 'application/json') => async () =>
	new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });

// ---- wording -------------------------------------------------------------------------------------------------

test('wording: GitHub text stays exactly what production shows; local text says local/ and never "commit & push"', () => {
	assert.equal(GITHUB_WORDING.where, 'GitHub');
	assert.equal(GITHUB_WORDING.sceneSaved, 'Saved — site rebuilding (~1–2 min).');
	assert.equal(GITHUB_WORDING.loaded, 'Loaded the latest scene from GitHub.');
	assert.equal(GITHUB_WORDING.modelsUpToDate, 'The model library on GitHub was already up to date. Nothing was committed.');
	assert.equal(GITHUB_WORDING.modelsSaved('1 added'), 'Saved models (1 added). Live after the site rebuilds (~1–2 min).');
	assert.equal(GITHUB_WORDING.modelsSaved(''), 'Saved models. Live after the site rebuilds (~1–2 min).');
	assert.match(LOCAL_WORDING.where, /local\//);
	assert.match(LOCAL_WORDING.loaded, /local\/scene\.json/);
	assert.match(LOCAL_WORDING.sceneSaved, /local\/scene\.json/);
	assert.match(LOCAL_WORDING.modelsSaved('1 added'), /\(1 added\)/);
	assert.match(LOCAL_WORDING.modelsSaved('1 added'), /local\/models/);
	assert.match(LOCAL_WORDING.modelsSaved('1 added'), /local\/models\.json/);
	assert.match(LOCAL_WORDING.modelsUpToDate, /local\//);
	assert.match(LOCAL_WORDING.modelAdded('Chair'), /local\/models/);
	assert.match(LOCAL_WORDING.ready, /Dev: saving to local\//);
	assert.match(LOCAL_WORDING.ready, /re-reads local\/scene\.json/);
	const texts = [LOCAL_WORDING.where, LOCAL_WORDING.loaded, LOCAL_WORDING.sceneSaved, LOCAL_WORDING.modelsUpToDate, LOCAL_WORDING.modelAdded('Chair'), LOCAL_WORDING.modelsSaved('x'), LOCAL_WORDING.modelsSaved(''), LOCAL_WORDING.ready];
	for (const text of texts) {
		assert.ok(!/GitHub|site rebuild/i.test(text), `local wording must not mention GitHub / rebuilds: ${text}`);
		assert.ok(!/commit\s*(&|and)\s*push|publish|committed|pushed/i.test(text), `local wording must not suggest committing or publishing: ${text}`);
	}
});

// ---- pingLocal -----------------------------------------------------------------------------------------------

test('pingLocal: true only for HTTP 200 with the right service name; every failure is false and never throws', async () => {
	assert.equal(await pingLocal({ fetch: stub(200, { ok: true, service: 'alishly-local-save', version: 1 }) }), true);
	assert.equal(await pingLocal({ fetch: stub(200, { ok: true, service: 'something-else' }) }), false);
	assert.equal(await pingLocal({ fetch: stub(200, '<html>') }), false);
	assert.equal(await pingLocal({ fetch: stub(200, 'null') }), false);
	assert.equal(await pingLocal({ fetch: stub(404, { service: 'alishly-local-save' }) }), false);
	assert.equal(await pingLocal({ fetch: stub(500, {}) }), false);
	assert.equal(await pingLocal({ fetch: async () => { throw new TypeError('fetch failed'); } }), false);
	// hangs forever -> times out
	assert.equal(await pingLocal({ timeoutMs: 20, fetch: (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))) }), false);
});

test('pingLocal: asks /__local-save/ping with no-store; and against the real middleware it is true', async () => {
	const seen: string[] = [];
	await pingLocal({ fetch: async (url, init) => { seen.push(url, String(init?.cache)); return stub(200, { service: 'alishly-local-save' })(); } });
	assert.deepEqual(seen, [`${LOCAL_BASE}ping`, 'no-store']);
	const { h } = await makeBackend();
	assert.equal(await pingLocal({ fetch: h.fetch }), true);
});

// ---- request shape -------------------------------------------------------------------------------------------

test('client: every request goes to /__local-save/, carries the custom header, is no-store, and never leaves the origin', async () => {
	const { client, requests } = await makeBackend({ glbs: ['chair'] });
	await client.getFile();
	await client.getFileAt('src/data/models.json', 'whatever');
	await client.getBlobSha('public/models/chair.glb', 'whatever');
	const head = await client.getHead();
	await client.putFile({ text: sceneWith('box'), message: 'm', sha: (await client.getFile()).sha });
	await client.commitFiles({ message: 'm', changes: [{ path: 'public/models/x.glb', bytes: GLB }], expectedHead: await client.getHead() });
	assert.ok(head);
	assert.ok(requests.length >= 6);
	for (const { url, init } of requests) {
		assert.ok(url.startsWith('/__local-save/'), url);
		assert.ok(!/github|https?:/i.test(url), url);
		assert.equal((init?.headers as Record<string, string>)['X-Alishly-Local-Save'], '1', url);
		assert.equal(init?.cache, 'no-store');
	}
});

test('client: paths are URL-encoded in the query; the ref argument is ignored', async () => {
	const calls: string[] = [];
	const client = createLocalClient({ fetch: async (url) => { calls.push(url); return stub(200, { text: 't', sha: 's'.repeat(40) })(); } });
	await client.getFileAt('src/data/models.json', 'abc');
	await client.getFileAt('a b/../c&d=e', 'abc');
	assert.equal(calls[0], '/__local-save/file?path=src%2Fdata%2Fmodels.json');
	assert.equal(calls[1], '/__local-save/file?path=a%20b%2F..%2Fc%26d%3De');
});

test('client: getFile reads scene.json; putFile PUTs JSON to scene.json with the sha and returns commitSha null', async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const client = createLocalClient({
		fetch: async (url, init) => {
			calls.push({ url, init });
			return init?.method === 'PUT' ? stub(200, { path: SCENE, sha: 'b'.repeat(40), head: 'h'.repeat(40) })() : stub(200, { path: SCENE, text: 'T', sha: 'a'.repeat(40) })();
		},
	});
	assert.deepEqual(await client.getFile(), { text: 'T', sha: 'a'.repeat(40) });
	const put = await client.putFile({ text: 'héllo ✓', message: 'ignored', sha: 'a'.repeat(40) });
	assert.deepEqual(put, { sha: 'b'.repeat(40), commitSha: null });
	assert.equal(calls[0].url, `/__local-save/file?path=${encodeURIComponent(SCENE)}`);
	assert.equal(calls[1].url, `/__local-save/file?path=${encodeURIComponent(SCENE)}&sha=${'a'.repeat(40)}`);
	assert.equal(calls[1].init?.method, 'PUT');
	assert.equal((calls[1].init?.headers as Record<string, string>)['Content-Type'], 'application/json');
	assert.equal(new TextDecoder().decode(calls[1].init?.body as Uint8Array), 'héllo ✓');
	await client.putFile({ text: 'x', message: 'm' });
	assert.ok(!calls[2].url.includes('sha='), 'no sha -> create-only request');
});

test('client: commitFiles frames write/delete changes (uint32 BE header length + JSON header + bytes) as octet-stream', async () => {
	let sent: { url: string; init?: RequestInit } | null = null;
	const client = createLocalClient({ fetch: async (url, init) => { sent = { url, init }; return stub(200, { head: 'n'.repeat(40), written: [], unchanged: [], deleted: [] })(); } });
	const result = await client.commitFiles({
		message: 'ignored',
		expectedHead: 'e'.repeat(40),
		changes: [{ path: 'public/models/a.glb', bytes: new Uint8Array([1, 2, 3]) }, { path: 'src/data/models.json', text: '[]é' }, { path: 'public/models/old.glb', delete: true }],
	});
	assert.deepEqual(result, { commitSha: 'n'.repeat(40) });
	const { url, init } = sent as unknown as { url: string; init: RequestInit };
	assert.equal(url, '/__local-save/commit');
	assert.equal(init.method, 'POST');
	assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/octet-stream');
	const body = Buffer.from(init.body as Uint8Array);
	const headerLength = body.readUInt32BE(0);
	const header = JSON.parse(body.subarray(4, 4 + headerLength).toString('utf8'));
	assert.deepEqual(header, {
		expectedHead: 'e'.repeat(40),
		changes: [{ path: 'public/models/a.glb', op: 'write', size: 3 }, { path: 'src/data/models.json', op: 'write', size: 4 }, { path: 'public/models/old.glb', op: 'delete' }],
	});
	assert.deepEqual([...body.subarray(4 + headerLength)], [1, 2, 3, ...Buffer.from('[]é')]);
});

test('client: commitFiles without expectedHead reads the head first', async () => {
	const urls: string[] = [];
	const client = createLocalClient({
		fetch: async (url) => {
			urls.push(url);
			return url.endsWith('head') ? stub(200, { head: 'h'.repeat(40) })() : stub(200, { head: 'n'.repeat(40) })();
		},
	});
	await client.commitFiles({ message: 'm', changes: [{ path: 'public/models/a.glb', delete: true }] });
	assert.deepEqual(urls, ['/__local-save/head', '/__local-save/commit']);
});

// ---- errors --------------------------------------------------------------------------------------------------

test('client: HTTP statuses map to GithubError kinds (409 conflict, 403/413/415/422 rejected, 404 not-found, 5xx server, other bad-response)', async () => {
	const cases: Array<[number, string]> = [[409, 'conflict'], [403, 'rejected'], [413, 'rejected'], [415, 'rejected'], [422, 'rejected'], [404, 'not-found'], [500, 'server'], [503, 'server'], [400, 'bad-response'], [405, 'bad-response']];
	for (const [status, kind] of cases) {
		const client = createLocalClient({ fetch: stub(status, { error: { kind: 'x', message: `server said ${status}` } }) });
		await assert.rejects(client.getHead(), (e: unknown) => e instanceof GithubError && e.kind === kind && e.status === status && e.message === `server said ${status}`, `${status}`);
	}
	// no usable body: a generic message that still names the status
	const client = createLocalClient({ fetch: stub(418, 'teapot', 'text/plain') });
	await assert.rejects(client.getHead(), (e: unknown) => e instanceof GithubError && /418/.test(e.message));
});

test('client: network failure -> "network", abort -> "timeout", unreadable 200 answers -> "bad-response"', async () => {
	await failsWith(createLocalClient({ fetch: async () => { throw new TypeError('fetch failed'); } }).getHead(), 'network');
	await failsWith(createLocalClient({ timeoutMs: 10, fetch: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))) }).getHead(), 'timeout');
	await failsWith(createLocalClient({ fetch: stub(200, '<html>nope</html>', 'text/html') }).getHead(), 'bad-response');
	await failsWith(createLocalClient({ fetch: stub(200, 'null') }).getHead(), 'bad-response');
	await failsWith(createLocalClient({ fetch: stub(200, { head: 5 }) }).getHead(), 'bad-response');
	await failsWith(createLocalClient({ fetch: stub(200, { text: 5, sha: 'x' }) }).getFile(), 'bad-response');
	await failsWith(createLocalClient({ fetch: stub(200, { sha: 5 }) }).getBlobSha('public/models/a.glb', 'r'), 'bad-response');
	await failsWith(createLocalClient({ fetch: stub(200, { nope: 1 }) }).putFile({ text: 'x', message: 'm' }), 'bad-response');
	await failsWith(createLocalClient({ fetch: stub(200, { nope: 1 }) }).commitFiles({ message: 'm', expectedHead: 'h', changes: [{ path: 'public/models/a.glb', delete: true }] }), 'bad-response');
});

test('client: the error message never contains a token-like string and the client has no way to be given one', async () => {
	const client = createLocalClient({ fetch: stub(403, { error: { message: 'nope' } }) });
	await assert.rejects(client.getFile(), (e: unknown) => e instanceof GithubError && !/token|bearer|authorization/i.test(e.message));
	// no Authorization header is ever sent
	let headers: Record<string, string> = {};
	await createLocalClient({ fetch: async (_u, init) => { headers = init?.headers as Record<string, string>; return stub(200, { head: 'h' })(); } }).getHead();
	assert.deepEqual(Object.keys(headers).map((k) => k.toLowerCase()), ['x-alishly-local-save']);
});

// ---- against the real endpoint ---------------------------------------------------------------------------------

test('e2e: getBlobSha is the real git blob sha1 (= git hash-object) for a glb, null when missing', async () => {
	const { client, root } = await makeBackend({ glbs: ['chair'] });
	const expected = execFileSync('git', ['hash-object', local(root, 'public/models/chair.glb')]).toString().trim();
	assert.equal(await client.getBlobSha('public/models/chair.glb', 'r'), expected);
	assert.equal(await client.getBlobSha('public/models/chair.glb', 'r'), await clientBlobSha(GLB));
	assert.equal(await client.getBlobSha('public/models/none.glb', 'r'), null);
	await failsWith(client.getBlobSha('package.json', 'r'), 'rejected', 403);
	await failsWith(client.getBlobSha('../package.json', 'r'), 'rejected', 403);
});

test('e2e: putFile writes scene.json, the returned sha is usable for the next save, a stale sha is a conflict', async () => {
	const { client, read } = await makeBackend();
	const first = await client.getFile();
	const put1 = await client.putFile({ text: sceneWith('box'), message: 'm', sha: first.sha });
	assert.equal((await read(SCENE)).toString(), sceneWith('box'));
	assert.equal(put1.sha, (await client.getFile()).sha);
	const put2 = await client.putFile({ text: sceneWith('lamp'), message: 'm', sha: put1.sha });
	assert.equal((await read(SCENE)).toString(), sceneWith('lamp'));
	await failsWith(client.putFile({ text: sceneWith('table'), message: 'm', sha: first.sha }), 'conflict', 409);
	assert.equal((await read(SCENE)).toString(), sceneWith('lamp'));
	assert.notEqual(put2.sha, put1.sha);
});

test('e2e: an invalid scene is rejected (422 -> "rejected") and not written; a file changed outside the page is a conflict', async () => {
	const { client, read, root } = await makeBackend();
	const first = await client.getFile();
	await failsWith(client.putFile({ text: '{"version":1', message: 'm', sha: first.sha }), 'rejected', 422);
	assert.equal((await read(SCENE)).toString(), sceneWith());
	await writeFile(local(root, SCENE), sceneWith('lamp')); // another editor
	await failsWith(client.putFile({ text: sceneWith('box'), message: 'm', sha: first.sha }), 'conflict');
	const reloaded = await client.getFile();
	assert.equal(reloaded.text, sceneWith('lamp'));
	await client.putFile({ text: sceneWith('box'), message: 'm', sha: reloaded.sha }); // "Overwrite" path after reload
	assert.equal((await read(SCENE)).toString(), sceneWith('box'));
});

test('e2e saveModels: add writes the glb and models.json; repeating it is a no-op; findSavedImports sees the saved import', async () => {
	const { client, read, root, committedUnchanged } = await makeBackend();
	const pending = { added: [{ entry: canonicalEntry('chair', 'Chair', 0.5), bytes: GLB }], removed: [] as string[] };
	const result = await saveModels({ github: client, scenePath: SCENE, slugs: SLUGS, pending, where: 'disk' });
	assert.equal(result.added, 1);
	assert.deepEqual(await read('public/models/chair.glb'), Buffer.from(GLB));
	assert.deepEqual(JSON.parse((await read(MODELS_JSON_PATH)).toString()), [canonicalEntry('chair', 'Chair', 0.5)]);
	const head = await client.getHead();
	const models = await client.getFileAt(MODELS_JSON_PATH, head);
	assert.deepEqual([...(await findSavedImports(client, models.text, pending.added, head))], ['chair']);
	const again = await saveModels({ github: client, scenePath: SCENE, slugs: SLUGS, pending, where: 'disk' });
	assert.equal(again.commitSha, null, 'nothing left to write');
	assert.deepEqual((await readdir(path.join(root, 'local/models'))).filter((f) => f.endsWith('.tmp')), []);
	assert.equal(await stat(path.join(root, 'public/models/chair.glb')).catch(() => null), null, 'nothing landed in public/models');
	await committedUnchanged();
});

test('e2e saveModels: delete is blocked while the on-disk scene uses the model, then removes entry and glb', async () => {
	const { client, read, root, committedUnchanged } = await makeBackend({ glbs: ['chair'], scene: sceneWith('model:chair') });
	const pending = { added: [], removed: ['chair'] };
	await assert.rejects(
		saveModels({ github: client, scenePath: SCENE, slugs: SLUGS, pending, where: 'disk' }),
		(e: unknown) => e instanceof GithubError && /on disk/.test(e.message) && !/GitHub/.test(e.message),
	);
	assert.ok(await stat(local(root, 'public/models/chair.glb')));
	assert.deepEqual(JSON.parse((await read(MODELS_JSON_PATH)).toString()).map((m: { id: string }) => m.id), ['chair']);
	// the scene no longer uses it
	await writeFile(local(root, SCENE), sceneWith());
	const result = await saveModels({ github: client, scenePath: SCENE, slugs: SLUGS, pending, where: 'disk' });
	assert.equal(result.removed, 1);
	assert.equal(await stat(local(root, 'public/models/chair.glb')).catch(() => null), null);
	assert.deepEqual(JSON.parse((await read(MODELS_JSON_PATH)).toString()), []);
	await committedUnchanged();
	assert.ok(await stat(path.join(root, 'public/models/committed-canary.glb')), 'the committed canary glb was not deleted');
});

test('e2e saveModels: two imports at once write both glbs and a models.json that lists exactly those', async () => {
	const { client, root } = await makeBackend();
	const order: string[] = [];
	const pending = { added: [{ entry: canonicalEntry('a1', 'A', 1), bytes: GLB }, { entry: canonicalEntry('b2', 'B', 1), bytes: GLB }], removed: [] as string[] };
	// poll the dir while committing is not deterministic; instead assert the final state and that models.json lists both glbs that exist
	await saveModels({ github: client, scenePath: SCENE, slugs: SLUGS, pending, where: 'disk' });
	const ids = JSON.parse((await readFile(local(root, MODELS_JSON_PATH), 'utf8'))).map((m: { id: string }) => m.id).sort();
	for (const id of ids) order.push(id);
	assert.deepEqual(order, ['a1', 'b2']);
	for (const id of ids) assert.ok(await stat(local(root, `public/models/${id}.glb`)));
});

test('e2e saveModels: a head that moved on (external change) is retried once; a second change in between fails as conflict', async () => {
	const { client, root } = await makeBackend();
	let moved = 0;
	const flaky: GithubClient = {
		...client,
		// move the head between reading it and committing, once
		getFileAt: async (p, r) => {
			const file = await client.getFileAt(p, r);
			if (moved++ === 1) await writeFile(local(root, SCENE), sceneWith('lamp'));
			return file;
		},
	};
	const pending = { added: [{ entry: canonicalEntry('chair', 'Chair', 1), bytes: GLB }], removed: [] as string[] };
	const result = await saveModels({ github: flaky, scenePath: SCENE, slugs: SLUGS, pending, where: 'disk' });
	assert.equal(result.added, 1, 'second attempt succeeded');
	// always-moving head -> conflict surfaces
	const { client: c2, root: r2 } = await makeBackend();
	let tick = 0;
	const always: GithubClient = {
		...c2,
		getFileAt: async (p, r) => {
			const file = await c2.getFileAt(p, r);
			await writeFile(local(r2, SCENE), sceneWith('box') + '\n'.repeat(++tick)); // a new content every time
			return file;
		},
	};
	await failsWith(saveModels({ github: always, scenePath: SCENE, slugs: SLUGS, pending, where: 'disk' }), 'conflict');
	assert.equal(await stat(local(r2, 'public/models/chair.glb')).catch(() => null), null);
});

test('e2e: a commit with a stale head is a conflict; with an invalid glb it is rejected and writes nothing', async () => {
	const { client, root } = await makeBackend({ glbs: ['old'] });
	const head = await client.getHead();
	await writeFile(local(root, SCENE), sceneWith('lamp'));
	await failsWith(client.commitFiles({ message: 'm', expectedHead: head, changes: [{ path: 'public/models/new.glb', bytes: GLB }] }), 'conflict', 409);
	const fresh = await client.getHead();
	await failsWith(client.commitFiles({ message: 'm', expectedHead: fresh, changes: [{ path: 'public/models/new.glb', bytes: new Uint8Array([1, 2, 3]) }] }), 'rejected', 422);
	await failsWith(client.commitFiles({ message: 'm', expectedHead: fresh, changes: [{ path: 'package.json', text: '{}' }] }), 'rejected', 403);
	await failsWith(client.commitFiles({ message: 'm', expectedHead: fresh, changes: [{ path: 'public/models/../../x.glb', bytes: GLB }] }), 'rejected', 403);
	assert.deepEqual((await readdir(path.join(root, 'local/models'))).sort(), ['old.glb']);
	assert.deepEqual(await readdir(base).then((d) => d.includes('x.glb')), false);
});

test('e2e: a request without the custom header is refused by the server (the guard really is enforced end to end)', async () => {
	const { h } = await makeBackend();
	const client = createLocalClient({ fetch: (url, init) => h.fetch(url, { ...init, headers: {} }) });
	await failsWith(client.getHead(), 'rejected', 403);
});

// ---- the committed files are never touched, whatever the client does ------------------------------------------------

test('e2e: scene save + models save + load + delete leave src/data/*.json and public/models/* byte-identical, and read back only local/', async () => {
	const { client, committedUnchanged, read } = await makeBackend();
	const first = await client.getFile();
	assert.equal(first.text, sceneWith(), 'Load latest returns local/scene.json (not the committed canary scene)');
	await client.putFile({ text: sceneWith('lamp'), message: 'm', sha: first.sha });
	const pending = { added: [{ entry: canonicalEntry('chair', 'Chair', 1), bytes: GLB }], removed: [] as string[] };
	await saveModels({ github: client, scenePath: SCENE, slugs: SLUGS, pending, where: 'disk' });
	await saveModels({ github: client, scenePath: SCENE, slugs: SLUGS, pending: { added: [], removed: ['chair'] }, where: 'disk' });
	assert.equal((await read(SCENE)).toString(), sceneWith('lamp'));
	await committedUnchanged();
});

// ---- fetchDiffers (banner info) ----------------------------------------------------------------------------------

test('fetchDiffers: returns the boolean from the head route, null for anything else, never throws; GET head with the guard header and no-store', async () => {
	const seen: Array<{ url: string; init?: RequestInit }> = [];
	const ok = (differs: unknown) => async (url: string, init?: RequestInit) => {
		seen.push({ url, init });
		return new Response(JSON.stringify({ head: 'h'.repeat(40), differs }), { status: 200, headers: { 'content-type': 'application/json' } });
	};
	assert.equal(await fetchDiffers({ fetch: ok(true) }), true);
	assert.equal(await fetchDiffers({ fetch: ok(false) }), false);
	assert.equal(seen[0].url, `${LOCAL_BASE}head`);
	assert.equal(seen[0].init?.cache, 'no-store');
	assert.equal((seen[0].init?.headers as Record<string, string>)['X-Alishly-Local-Save'], '1');
	assert.ok(!seen[0].init?.method || seen[0].init.method === 'GET');
	for (const bad of ['yes', 1, null, undefined, {}]) assert.equal(await fetchDiffers({ fetch: ok(bad) }), null, JSON.stringify(bad));
	assert.equal(await fetchDiffers({ fetch: stub(200, { head: 'x' }) }), null, 'field missing');
	assert.equal(await fetchDiffers({ fetch: stub(500, { error: {} }) }), null);
	assert.equal(await fetchDiffers({ fetch: stub(403, { error: {} }) }), null);
	assert.equal(await fetchDiffers({ fetch: stub(200, '<html>') }), null);
	assert.equal(await fetchDiffers({ fetch: async () => { throw new TypeError('fetch failed'); } }), null);
	assert.equal(await fetchDiffers({ timeoutMs: 20, fetch: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))) }), null);
});

test('fetchDiffers against the real middleware: true while local/ differs from the committed files, false once they match, true again after a save', async () => {
	const { h, root, client } = await makeBackend();
	assert.equal(await fetchDiffers({ fetch: h.fetch }), true, 'seed: local scene and models differ from the committed canaries');
	// make local/ byte-identical to the committed twins
	await writeFile(path.join(root, 'local/scene.json'), await readFile(path.join(root, 'src/data/scene.json')));
	await writeFile(path.join(root, 'local/models.json'), await readFile(path.join(root, 'src/data/models.json')));
	assert.equal(await fetchDiffers({ fetch: h.fetch }), false);
	const f = await client.getFile();
	await client.putFile({ text: sceneWith('box'), message: 'm', sha: f.sha });
	assert.equal(await fetchDiffers({ fetch: h.fetch }), true);
});
