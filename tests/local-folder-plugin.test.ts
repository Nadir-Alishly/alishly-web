// Task local-folder, plugin: the Vite hooks of dev/local-save-plugin.mjs driven without a dev server —
//  - `load`: swaps exactly the `src/data/scene.json?raw` / `src/data/models.json?raw` module ids for the local/ files,
//    for both environments, and is inert before/without configureServer, in `build`, and when the plugin fails closed;
//  - the `/models/<id>.glb` middleware: served from local/models only, 404 for everything else under /models/ (never
//    public/models), HEAD, headers, traversal / encoded / odd ids, symlinks;
//  - the `differs` flag of the head route, the watcher registration and the hotUpdate behaviour for creation.
// Temp repo roots live in tests/.tmp-local-folder-plugin-*, removed in after(). Real Vite behaviour (the plugin order
// against Vite's own raw loader, public-dir middleware order, HMR) can only be seen in the browser pass (tester-r1b).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import localSavePlugin from '../dev/local-save-plugin.mjs';
import { serializeScene, emptyScene } from '../src/data/scene.ts';
import { makeBoxGlb } from './helpers/gltf-fixtures.ts';
import { makeHarness } from './helpers/local-save-http.ts';
import { COMMITTED_GLB, COMMITTED_MODELS, COMMITTED_SCENE, SLUGS, modelsJsonText, sceneWithObject, seedRepo, snapshotCommitted } from './helpers/local-repo.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB = Buffer.from(makeBoxGlb());
const G = { 'x-alishly-local-save': '1' };
/** What the core creates when local/scene.json is missing. */
const EMPTY_SCENE_TEXT = serializeScene(emptyScene([]));
/** What seedRepo writes by default (an empty scene that lists every room). */
const SEEDED_EMPTY_SCENE = serializeScene(emptyScene(SLUGS));
/** Polls until `fn` is truthy (the startup work of the plugin runs after configureServer returns). */
async function until(fn: () => boolean | Promise<boolean>, what: string) {
	for (let i = 0; i < 200; i++) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.fail(`timed out waiting for: ${what}`);
}
const fwd = (p: string) => p.split(path.sep).join('/');
const exists = (p: string) => lstat(p).then(() => true, () => false);

let base = '';
let n = 0;
before(async () => {
	base = await mkdtemp(path.join(HERE, '.tmp-local-folder-plugin-'));
});
after(async () => {
	if (base) await rm(base, { recursive: true, force: true });
});

async function server(opts: Parameters<typeof seedRepo>[1] & { bare?: boolean; watcher?: boolean } = {}) {
	const root = path.join(base, `repo${n++}`);
	if (opts.bare) await mkdir(root, { recursive: true });
	else await seedRepo(root, opts);
	const h = await makeHarness({ root, watcher: opts.watcher });
	await h.ready();
	if (!opts.bare) {
		// the plugin's own startup work (ensure local/, watcher, sweep) runs after configureServer returns; one API round trip
		// shares its in-flight ensureLocal, then let the rest settle, so a test that deletes local/ does not race with it
		await h.fetch('/__local-save/head', { headers: G });
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	}
	const load = async (id: string, environment = 'client') => {
		const watched: string[] = [];
		const out = await (h.plugin as any).load.call({ environment: { name: environment }, addWatchFile: (f: string) => watched.push(f) }, id);
		return { out, watched };
	};
	return { root, h, load, abs: (rel: string) => path.join(root, rel), id: (rel: string) => `${fwd(root)}/${rel}` };
}
/** The text a `load` result exports (it is `export default <JSON string>;`). */
const exported = (out: { code: string } | null): string => {
	assert.ok(out && typeof out.code === 'string', 'load returned a module');
	const m = /^export default ([\s\S]*);$/.exec(out.code);
	assert.ok(m, `unexpected module code: ${out.code.slice(0, 80)}`);
	return JSON.parse(m[1]) as string;
};

// ---- `load` hook -------------------------------------------------------------------------------------------------

test('plugin shape: apply "serve", enforce "pre" (so it sees the ?raw ids before Vite\'s own raw loader), a load hook, no transform', () => {
	const plugin = localSavePlugin() as any;
	assert.equal(plugin.apply, 'serve');
	assert.equal(plugin.enforce, 'pre');
	assert.equal(typeof plugin.load, 'function');
	assert.equal(plugin.transform, undefined, 'only load, nothing rewrites other modules');
	assert.equal(plugin.resolveId, undefined, 'ids are not rewritten, only their content');
});

test('load: src/data/scene.json?raw and src/data/models.json?raw return the LOCAL files (not the committed ones), as `export default <string>`', async () => {
	const localScene = sceneWithObject('LOCAL_ONLY', 'lamp');
	const localModels = modelsJsonText('local-model');
	const { load, id, abs } = await server({ scene: localScene, models: localModels });
	const scene = await load(id('src/data/scene.json?raw'));
	assert.equal(exported(scene.out), localScene);
	assert.notEqual(exported(scene.out), COMMITTED_SCENE);
	assert.deepEqual(scene.out.map, null);
	assert.deepEqual(scene.watched, [abs('local/scene.json')], 'the local file is watched for module invalidation');
	const models = await load(id('src/data/models.json?raw'));
	assert.equal(exported(models.out), localModels);
	assert.notEqual(exported(models.out), COMMITTED_MODELS);
	assert.deepEqual(models.watched, [abs('local/models.json')]);
	assert.ok(!scene.out.code.includes('COMMITTED_CANARY') && !models.out.code.includes('committed-canary'));
});

test('load: the swap is the same in the client and the ssr environment (and any other)', async () => {
	const { load, id } = await server({ scene: sceneWithObject('X', 'box') });
	const outs = [];
	for (const env of ['client', 'ssr', 'prerender']) outs.push(exported((await load(id('src/data/scene.json?raw'), env)).out));
	assert.equal(new Set(outs).size, 1);
	assert.equal(outs[0], sceneWithObject('X', 'box'));
});

test('load: accepts the ?raw query in the forms Vite produces and ignores everything else', async () => {
	const { load, id } = await server();
	const swapped = ['?raw', '?raw&import', '?import&raw', '?t=123&raw', '?raw=', '?raw&t=1'];
	for (const q of swapped) assert.equal(exported((await load(id(`src/data/scene.json${q}`))).out), SEEDED_EMPTY_SCENE, q);
	const untouched = [
		'src/data/scene.json', // a plain import of the JSON (not used by the app; must stay Vite's)
		'src/data/scene.json?url', 'src/data/scene.json?inline', 'src/data/scene.json?import', 'src/data/scene.json?rawx', 'src/data/scene.json?xraw',
		'src/data/scene.json?foo=raw', 'src/data/scene.json?', 'src/data/scene.json?raw-not',
		'src/data/models.json', 'src/data/models.json?url',
		'src/data/family.ts?raw', 'src/data/scene.ts?raw', 'src/data/load-scene.ts?raw', 'src/data/scene.json.bak?raw', 'src/data/Scene.json?raw',
		'src/data/sub/scene.json?raw', 'src/data/scene.json/x?raw', 'package.json?raw', 'local/scene.json?raw', 'public/models/a.glb?raw',
		'src/scene.json?raw', 'data/scene.json?raw',
	];
	for (const rel of untouched) assert.equal((await load(id(rel))).out, null, rel);
	// ids from another root, relative ids, virtual ids
	for (const other of ['/etc/passwd?raw', '/elsewhere/src/data/scene.json?raw', 'src/data/scene.json?raw', '/src/data/scene.json?raw', '\0virtual:x?raw', '']) {
		assert.equal((await load(other)).out, null, JSON.stringify(other));
	}
});

test('load: follows hand edits and deletion of local/ (the next load re-reads / re-creates, never falls back to the committed files)', async () => {
	const { load, id, abs, root } = await server({ scene: sceneWithObject('A', 'box'), models: '[]\n' });
	assert.equal(exported((await load(id('src/data/scene.json?raw'))).out), sceneWithObject('A', 'box'));
	await writeFile(abs('local/scene.json'), sceneWithObject('B', 'lamp'));
	assert.equal(exported((await load(id('src/data/scene.json?raw'))).out), sceneWithObject('B', 'lamp'));
	// committed twin edited: no effect
	await writeFile(abs('src/data/scene.json'), sceneWithObject('C', 'box'));
	assert.equal(exported((await load(id('src/data/scene.json?raw'))).out), sceneWithObject('B', 'lamp'));
	// local/ removed entirely: re-created empty, NOT the committed content
	await rm(abs('local'), { recursive: true });
	const afterDelete = exported((await load(id('src/data/models.json?raw'))).out);
	assert.equal(afterDelete, '[]\n');
	assert.equal(exported((await load(id('src/data/scene.json?raw'))).out), EMPTY_SCENE_TEXT);
	assert.deepEqual((await readdir(path.join(root, 'local'))).sort(), ['models', 'models.json', 'scene.json']);
	// hand-broken JSON is passed through verbatim (the app's loader reports it, as for the committed file)
	await writeFile(abs('local/scene.json'), '{ broken');
	assert.equal(exported((await load(id('src/data/scene.json?raw'))).out), '{ broken');
});

test('load: a missing local/ on a bare checkout (no src/data at all) still works — nothing is read from the committed side', async () => {
	const { load, id, root } = await server({ bare: true });
	assert.equal(exported((await load(id('src/data/scene.json?raw'))).out), EMPTY_SCENE_TEXT);
	assert.equal(exported((await load(id('src/data/models.json?raw'))).out), '[]\n');
	assert.equal(await exists(path.join(root, 'src')), false);
});

test('load: an unsafe local/ (symlink / outside / wrong type) THROWS — no silent fallback to the committed files, nothing written outside', async () => {
	const cases: Array<[string, (r: { abs: (p: string) => string; outside: string }) => Promise<void>]> = [
		['local -> outside dir', async ({ abs, outside }) => { await rm(abs('local'), { recursive: true }); await symlink(outside, abs('local')); }],
		['local/models -> outside dir', async ({ abs, outside }) => { await rm(abs('local/models'), { recursive: true }); await symlink(outside, abs('local/models')); }],
		['local/scene.json -> outside file', async ({ abs, outside }) => { await writeFile(path.join(outside, 'f'), 'SECRET'); await rm(abs('local/scene.json')); await symlink(path.join(outside, 'f'), abs('local/scene.json')); }],
		['local is a file', async ({ abs }) => { await rm(abs('local'), { recursive: true }); await writeFile(abs('local'), 'x'); }],
	];
	for (const [name, setup] of cases) {
		const { load, id, abs, h, root } = await server();
		const outside = path.join(base, `outside${n++}`);
		await mkdir(outside);
		await setup({ abs, outside });
		// The hook throws (Vite shows its error overlay, maybe to a LAN client): the message names the repo-relative file and
		// carries the core's own (path-free) text; absolute paths only go to the dev server log.
		for (const [file, query] of [['scene', 'src/data/scene.json?raw'], ['models', 'src/data/models.json?raw']] as const) {
			await assert.rejects(load(id(query)), (e: unknown) => {
				const message = (e as Error).message;
				assert.match(message, new RegExp(`^\\[local-save\\] cannot read local/${file}\\.json: `), name);
				assert.ok(!message.includes(root) && !message.includes(base) && !message.includes('/home/'), `${name}: no absolute path in the thrown message: ${message}`);
				return true;
			}, name);
		}
		assert.ok(h.logs.some((l) => l.level === 'error' && /cannot read local\/scene\.json/.test(l.text)), `${name}: the details go to the dev server log`);
		const left = await readdir(outside);
		assert.deepEqual(left, name.includes('outside file') ? ['f'] : [], `${name}: nothing created outside`);
	}
});

test('load: inert until the plugin knows it is serving — never configured, `build` (configResolved and configureServer), a different root: returns null and creates no local/', async () => {
	const rootA = path.join(base, `repo${n++}`);
	await mkdir(rootA, { recursive: true });
	const id = `${fwd(rootA)}/src/data/scene.json?raw`;
	const quiet = { info() {}, warn() {}, error() {} };
	// 1. neither configResolved nor configureServer called
	const fresh = localSavePlugin() as any;
	assert.equal(await fresh.load.call({ addWatchFile() {} }, id), null);
	// 2. `astro build`: both hooks are no-ops for command 'build', load stays inert
	const used: unknown[] = [];
	const built = localSavePlugin() as any;
	built.configResolved({ command: 'build', root: rootA, logger: quiet });
	built.configureServer({ config: { command: 'build', root: rootA, logger: quiet, server: {} }, middlewares: { use: (f: unknown) => used.push(f) } });
	assert.equal(await built.load.call({ addWatchFile() {} }, id), null);
	assert.deepEqual(used, [], 'no middleware registered in a build');
	// 3. serving: configResolved alone is enough for the read side (a ?raw load can come before configureServer)
	const serving = localSavePlugin() as any;
	serving.configResolved({ command: 'serve', root: rootA, logger: quiet });
	assert.equal(exported(await serving.load.call({ addWatchFile() {} }, id)), EMPTY_SCENE_TEXT);
	assert.ok(await exists(path.join(rootA, 'local/scene.json')), 'the first load created local/');
	// a plugin serving root A answers only for root A's ids
	assert.equal(await serving.load.call({ addWatchFile() {} }, `${fwd(path.join(base, 'elsewhere'))}/src/data/scene.json?raw`), null);
});

test('non-loopback dev server (server.host / allowedHosts): reads stay on (load, /models, local/ created), the WRITE API answers 403 "disabled", nothing is swept or written', async () => {
	for (const serverConfig of [{ host: true }, { host: '0.0.0.0' }, { host: '192.168.1.5' }, { allowedHosts: true }]) {
		const root = path.join(base, `repo${n++}`);
		await seedRepo(root, { glbs: ['chair'] });
		const stale = path.join(root, 'local/.scene.json.0123456789ab.tmp');
		await writeFile(stale, 'junk');
		const old = new Date(Date.now() - 10 * 60_000);
		await (await import('node:fs/promises')).utimes(stale, old, old);
		const h = await makeHarness({ root, serverConfig });
		await h.ready().catch(() => {});
		const tag = JSON.stringify(serverConfig);
		assert.ok(h.logs.some((l) => l.level === 'warn' && /write API disabled/.test(l.text) && /still read from local\//.test(l.text)), tag);
		assert.ok(!h.logs.some((l) => /endpoint ready/.test(l.text)), tag);
		assert.ok(h.logs.some((l) => /reading local\/ \(write API off\)/.test(l.text)), tag);
		// the API middleware is still handlers[0], and refuses everything (even ping) with a 403 that says why
		assert.equal(h.handlers.length, 2, tag);
		for (const [method, url] of [['GET', '/__local-save/ping'], ['GET', '/__local-save/head'], ['GET', `/__local-save/file?path=${encodeURIComponent('src/data/scene.json')}`], ['PUT', `/__local-save/file?path=${encodeURIComponent('src/data/scene.json')}`], ['POST', '/__local-save/commit']] as const) {
			const res = await h.fetch(url, { method, headers: { ...G, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : new Uint8Array(4) });
			assert.equal(res.status, 403, `${tag} ${method} ${url}`);
			assert.match(((await res.json()) as any).error.message, /disabled.*beyond localhost.*Nothing was saved/);
		}
		// reads from local/ are on
		assert.equal(exported(await (h.plugin as any).load.call({ addWatchFile() {} }, `${fwd(root)}/src/data/scene.json?raw`)), SEEDED_EMPTY_SCENE, tag);
		const glb = await h.glb('GET', '/models/chair.glb');
		assert.equal(glb.status, 200, tag);
		assert.deepEqual(Buffer.from(await glb.arrayBuffer()), GLB);
		assert.equal((await h.glb('GET', '/models/committed-canary.glb')).status, 404, tag);
		// the startup sweep (a write) is skipped; the data is untouched
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(await readFile(stale, 'utf8'), 'junk', `${tag}: no sweep`);
		assert.equal(await readFile(path.join(root, 'local/scene.json'), 'utf8'), SEEDED_EMPTY_SCENE);
	}
	// loopback hosts are fine (the write API is on)
	for (const serverConfig of [{}, { host: 'localhost' }, { host: '127.0.0.1' }, { host: false }]) {
		const root = path.join(base, `repo${n++}`);
		await seedRepo(root, {});
		const h = await makeHarness({ root, serverConfig: serverConfig as never });
		await h.ready();
		assert.ok(h.logs.some((l) => /endpoint ready/.test(l.text)), JSON.stringify(serverConfig));
		assert.equal((await h.fetch('/__local-save/ping')).status, 200);
	}
});

test('startup: configureServer creates local/ right away (before any request) and logs what it created; an existing local/ logs nothing', async () => {
	const fresh = await server({ bare: true });
	// no request touched the store: the plugin itself creates local/ at startup (asynchronously, after configureServer returns)
	await until(async () => (await exists(fresh.abs('local/scene.json'))) && (await exists(fresh.abs('local/models.json'))) && (await exists(fresh.abs('local/models'))), 'startup creation of local/');
	await until(() => fresh.h.logs.some((l) => /created/.test(l.text)), 'the "created" log line');
	assert.ok(fresh.h.logs.some((l) => l.level === 'info' && /\[local-save\] created local\/, local\/models\/, local\/scene\.json, local\/models\.json/.test(l.text)), JSON.stringify(fresh.h.logs));
	assert.equal(await readFile(fresh.abs('local/scene.json'), 'utf8'), EMPTY_SCENE_TEXT);
	const existing = await server();
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(!existing.h.logs.some((l) => /created/.test(l.text)));
	assert.equal(existing.h.logs.filter((l) => l.level !== 'info').length, 0);
});

test('startup with an unsafe local/: logs an error, still answers requests with 403 (never reads/writes), load throws', async () => {
	const root = path.join(base, `repo${n++}`);
	await seedRepo(root, {});
	const outside = path.join(base, `outside${n++}`);
	await mkdir(outside);
	await rm(path.join(root, 'local'), { recursive: true });
	await symlink(outside, path.join(root, 'local'));
	const h = await makeHarness({ root });
	await h.ready().catch(() => {});
	await until(() => h.logs.some((l) => l.level === 'error'), 'the startup error log');
	assert.ok(h.logs.some((l) => l.level === 'error' && /plain folder inside the repository/.test(l.text)), JSON.stringify(h.logs));
	await assert.rejects((h.plugin as any).load.call({ addWatchFile() {} }, `${fwd(root)}/src/data/scene.json?raw`), /cannot read local\/scene\.json/);
	const res = await h.fetch(`/__local-save/file?path=${encodeURIComponent('src/data/scene.json')}`, { headers: G });
	assert.equal(res.status, 403);
	assert.deepEqual(await readdir(outside), []);
	assert.equal((await h.glb('GET', '/models/a.glb')).status, 403, 'the glb route refuses too (not a 404 that looks like "no models")');
});

test('startup: server.watcher.add is called with the two local data files (hand edits then reach hotUpdate); a server without a watcher is fine', async () => {
	const withWatcher = await server({ watcher: true });
	await until(() => withWatcher.h.watched.length >= 2, 'watcher.add');
	assert.deepEqual([...withWatcher.h.watched].sort(), [withWatcher.abs('local/models.json'), withWatcher.abs('local/scene.json')].sort());
	const without = await server();
	assert.deepEqual(without.h.watched, []);
});

// ---- /models/<id>.glb ------------------------------------------------------------------------------------------------

test('glb route: GET serves local/models/<id>.glb with model/gltf-binary, exact length, no-store, nosniff and the exact bytes', async () => {
	const { h, abs } = await server({ glbs: ['chair'] });
	const res = await h.glb('GET', '/models/chair.glb');
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
	assert.equal(res.headers.get('content-length'), String(GLB.byteLength));
	assert.equal(res.headers.get('cache-control'), 'no-store');
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	assert.deepEqual(Buffer.from(await res.arrayBuffer()), GLB);
	// no guard header needed (the GLTFLoader cannot send one) and a query string is ignored
	assert.equal((await h.glb('GET', '/models/chair.glb?v=123')).status, 200);
	// always the current bytes (no caching on the server side)
	const bigger = Buffer.concat([GLB, Buffer.alloc(16)]);
	await writeFile(abs('local/models/chair.glb'), bigger);
	const again = await h.glb('GET', '/models/chair.glb');
	assert.equal(again.headers.get('content-length'), String(bigger.byteLength));
	assert.deepEqual(Buffer.from(await again.arrayBuffer()), bigger);
});

test('glb route: HEAD answers the same headers with no body; a zero-byte file is an empty 200', async () => {
	const { h, abs } = await server({ glbs: ['chair'] });
	const head = await h.glb('HEAD', '/models/chair.glb');
	assert.equal(head.status, 200);
	assert.equal(head.headers.get('content-type'), 'model/gltf-binary');
	assert.equal(head.headers.get('content-length'), String(GLB.byteLength));
	assert.equal(head.headers.get('cache-control'), 'no-store');
	assert.equal((await head.arrayBuffer()).byteLength, 0);
	await writeFile(abs('local/models/empty.glb'), '');
	const empty = await h.glb('GET', '/models/empty.glb');
	assert.equal(empty.status, 200);
	assert.equal(empty.headers.get('content-length'), '0');
	assert.equal((await empty.arrayBuffer()).byteLength, 0);
});

test('glb route: a multi-megabyte file streams intact', async () => {
	const { h, abs } = await server();
	const big = Buffer.alloc(3 * 1024 * 1024 + 123);
	for (let i = 0; i < big.length; i += 4099) big[i] = i % 251;
	await writeFile(abs('local/models/big.glb'), big);
	const res = await h.glb('GET', '/models/big.glb');
	assert.equal(res.status, 200);
	assert.deepEqual(Buffer.from(await res.arrayBuffer()), big);
});

test('glb route: a model that exists ONLY in public/models is a 404 in dev (never a fall-through to the committed file), also with a models.json entry', async () => {
	const { h, abs, root } = await server({ models: modelsJsonText('committed-canary') });
	assert.ok(await exists(abs('public/models/committed-canary.glb')), 'the committed glb exists on disk');
	const res = await h.glb('GET', '/models/committed-canary.glb');
	assert.equal(res.status, 404);
	assert.equal(res.headers.get('cache-control'), 'no-store');
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
	const body = await res.text();
	assert.ok(!body.includes(root) && !body.includes('/home/'), body);
	assert.notDeepEqual(Buffer.from(body), COMMITTED_GLB);
	assert.equal((await h.glb('HEAD', '/models/committed-canary.glb')).status, 404);
	// once the same id is imported locally, the LOCAL bytes are served, not the committed ones
	const localBytes = Buffer.concat([GLB, Buffer.from('LOCAL')]);
	await writeFile(abs('local/models/committed-canary.glb'), localBytes);
	assert.deepEqual(Buffer.from(await (await h.glb('GET', '/models/committed-canary.glb')).arrayBuffer()), localBytes);
});

test('glb route: never calls next() (so Vite\'s public dir / Astro never answer) for any GET or HEAD under /models/ — missing, odd, traversal and encoded ids are 404', async () => {
	const { h } = await server({ glbs: ['chair'] });
	const urls = [
		'/models/missing.glb', '/models/.glb', '/models/..glb', '/models/...glb', '/models/a b.glb', '/models/a%20b.glb', '/models/%63hair.glb', '/models/chair%2eglb',
		'/models/chair.GLB', '/models/CHAIR.glb', '/models/chair.gltf', '/models/chair.glb.tmp', '/models/chair.glb/', '/models/chair.glb/x', '/models/sub/chair.glb', '/models//chair.glb',
		'/models', '/models/', '/Models/chair.glb', '/MODELS/CHAIR.glb', '/models/index.html', '/models/models.json', '/models/scene.json', '/models/..%2fpackage.json', '/models/%2e%2e%2fpackage.json',
		'/models/%2e%2e/chair.glb', '/models/..%5cchair.glb', '/models/a\\b.glb', '/models/chair.glb%00', '/models/chair%00.glb', '/models/%00.glb', '/models/x'.concat('y'.repeat(70), '.glb'),
		'/models/committed-canary.glb', '/models/./chair.glb.', '/models/chair.glb%2f', '/models/%2fchair.glb', '/models/ü.glb', '/models/%C3%BC.glb', '/models/.hidden.glb',
		'/models/.chair.glb.0123456789ab.tmp', '/models/chair.glb;x', '/models/chair.glb%20',
	];
	for (const url of urls) {
		for (const method of ['GET', 'HEAD']) {
			const res = await h.glb(method, url);
			assert.notEqual(res.status, 599, `${method} ${url} must not fall through`);
			if (url === '/models/chair.glb/' ) continue;
			assert.ok([404, 403].includes(res.status), `${method} ${url} -> ${res.status}`);
			assert.equal(res.status, 404, `${method} ${url}`);
			assert.equal(res.headers.get('cache-control'), 'no-store');
		}
	}
});

test('glb route: only GET/HEAD are handled; other methods and every URL outside /models/ fall through to the next middleware', async () => {
	const { h } = await server({ glbs: ['chair'] });
	for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await h.glb(method, '/models/chair.glb')).status, 599, method);
	for (const url of ['/', '/admin', '/rooms/elnur/', '/model/chair.glb', '/modelsx/chair.glb', '/_astro/x.js', '/__local-save/ping', '/public/models/chair.glb', '/src/data/scene.json', '/models/../package.json', '/foo/../rooms/elnur/']) {
		assert.equal((await h.glb('GET', url)).status, 599, url);
	}
	// a path that FOLDS out of /models (so Vite's public dir cannot reach public/models with it either) is not ours
	assert.equal((await h.glb('GET', '/models/../models/chair.glb')).status, 404, 'but one that folds back into /models is answered here (and 404s: not exactly /models/<id>.glb)');
});

test('glb route: an unsafe local/models (symlink / outside) or a symlinked / dangling / directory glb is a 403 that leaks no path — and nothing outside the repo is read', async () => {
	const { h, abs, root } = await server({ glbs: ['chair'] });
	const outside = path.join(base, `outside${n++}`);
	await mkdir(outside);
	await writeFile(path.join(outside, 'secret.glb'), 'SECRET-BYTES');
	await symlink(path.join(outside, 'secret.glb'), abs('local/models/trap.glb'));
	await symlink(abs('nowhere.glb'), abs('local/models/dangling.glb'));
	await mkdir(abs('local/models/dir.glb'));
	for (const id of ['trap', 'dangling', 'dir']) {
		for (const method of ['GET', 'HEAD']) {
			const res = await h.glb(method, `/models/${id}.glb`);
			assert.equal(res.status, 403, `${method} ${id}`);
			const text = await res.text();
			assert.ok(!text.includes('SECRET-BYTES') && !text.includes(root) && !text.includes('/home/'), text);
		}
	}
	assert.equal((await h.glb('GET', '/models/chair.glb')).status, 200, 'a plain neighbour is still served');
	// whole directory redirected
	await rm(abs('local/models'), { recursive: true });
	await symlink(outside, abs('local/models'));
	await writeFile(path.join(outside, 'chair.glb'), 'OUTSIDE');
	const res = await h.glb('GET', '/models/chair.glb');
	assert.equal(res.status, 403);
	assert.ok(!(await res.text()).includes('OUTSIDE'));
	assert.deepEqual((await readdir(outside)).sort(), ['chair.glb', 'secret.glb']);
});

test('glb route: with local/ deleted the next request re-creates it and answers 404 (an empty library), not an error', async () => {
	const { h, abs } = await server({ glbs: ['chair'] });
	await rm(abs('local'), { recursive: true });
	const res = await h.glb('GET', '/models/chair.glb');
	assert.equal(res.status, 404);
	assert.ok(await exists(abs('local/models')) && await exists(abs('local/scene.json')));
});

test('glb route does not interfere with the API: the API stays handlers[0], and /__local-save/* is not a /models/ request', async () => {
	const { h } = await server();
	assert.equal(h.handlers.length, 2);
	assert.equal((await h.fetch('/__local-save/ping')).status, 200);
	assert.equal((await h.raw('GET', '/models/x.glb', { host: 'localhost:4321' })).status, 599, 'the API middleware ignores /models/');
});

// ---- head: differs -------------------------------------------------------------------------------------------------------

test('head route: carries `differs` (boolean) next to `head`; needs the guard header; ping stays exactly {ok, service, version}', async () => {
	const { h, root, abs } = await server();
	const url = '/__local-save/head';
	assert.equal((await h.fetch(url)).status, 403, 'no guard header');
	const body = await (await h.fetch(url, { headers: G })).json();
	assert.deepEqual(Object.keys(body).sort(), ['differs', 'head']);
	assert.equal(body.differs, true);
	assert.match(body.head, /^[0-9a-f]{40}$/);
	assert.deepEqual(await (await h.fetch('/__local-save/ping')).json(), { ok: true, service: 'alishly-local-save', version: 1 });
	await writeFile(abs('local/scene.json'), await readFile(path.join(root, 'src/data/scene.json')));
	await writeFile(abs('local/models.json'), await readFile(path.join(root, 'src/data/models.json')));
	const same = await (await h.fetch(url, { headers: G })).json();
	assert.equal(same.differs, false);
	assert.notEqual(same.head, body.head, 'the head token still follows the local files');
	assert.equal((await h.fetch(url, { method: 'POST', headers: G })).status, 405);
	// a save through the API flips it back; committed files untouched
	const before = await snapshotCommitted(root);
	const file = await (await h.fetch(`/__local-save/file?path=${encodeURIComponent('src/data/scene.json')}`, { headers: G })).json();
	assert.equal(file.text, COMMITTED_SCENE, 'local copy is currently identical to the committed one');
	const put = await h.fetch(`/__local-save/file?path=${encodeURIComponent('src/data/scene.json')}&sha=${file.sha}`, { method: 'PUT', headers: { ...G, 'content-type': 'application/json' }, body: new TextEncoder().encode(sceneWithObject('NEW', 'box')) });
	assert.equal(put.status, 200);
	assert.equal((await (await h.fetch(url, { headers: G })).json()).differs, true);
	assert.deepEqual(await snapshotCommitted(root), before);
});

// ---- hotUpdate for the files created at startup ----------------------------------------------------------------------

test('hotUpdate: the files ensureLocal created at startup count as the plugin\'s own writes for the mark TTL, a hand edit afterwards reloads (documented 5 s window)', async (t) => {
	const root = path.join(base, `repo${n++}`);
	await mkdir(root, { recursive: true });
	const h = await makeHarness({ root });
	await h.ready();
	const hook = (h.plugin as any).hotUpdate;
	const localScene = fwd(path.join(root, 'local/scene.json'));
	const env = () => ({ name: 'ssr', moduleGraph: { invalidateModule: (_m: unknown, seen: Set<unknown>) => seen.add(_m), getModulesByFile: () => undefined } });
	// the plugin creates the files shortly after configureServer; wait for that (the mark is set before the first write)
	await until(() => hook.handler.call({ environment: env() }, { file: localScene, modules: [], timestamp: 1 }) !== undefined, 'the creation mark');
	assert.deepEqual(hook.handler.call({ environment: env() }, { file: localScene, modules: [], timestamp: 1 }), [], 'creation event swallowed (no reload for the files we just made)');
	t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
	t.mock.timers.tick(5_001);
	assert.equal(hook.handler.call({ environment: env() }, { file: localScene, modules: [], timestamp: 2 }), undefined, 'after the TTL a hand edit is a normal event');
});

test('load: a raw fs failure (EACCES) is reported as "error EACCES" — no absolute path, no fs message in what Vite shows', async (t) => {
	if (process.getuid?.() === 0) return t.skip('root ignores file permissions');
	const { load, id, abs, root, h } = await server();
	const { chmod } = await import('node:fs/promises');
	await chmod(abs('local/scene.json'), 0o000);
	try {
		await assert.rejects(load(id('src/data/scene.json?raw')), (e: unknown) => {
			const message = (e as Error).message;
			assert.equal(message, '[local-save] cannot read local/scene.json: error EACCES');
			assert.ok(!message.includes(root));
			return true;
		});
		assert.ok(h.logs.some((l) => l.level === 'error' && /cannot read local\/scene\.json/.test(l.text) && l.text.includes('EACCES')), 'full error in the dev server log');
	} finally {
		await chmod(abs('local/scene.json'), 0o644);
	}
});
