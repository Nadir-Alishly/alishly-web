// Dev-only Vite plugin: under `npm run dev` the scene, the model list and the model files live in the git-ignored
// `local/` folder (local/scene.json, local/models.json, local/models/<id>.glb), NEVER in the committed
// src/data/*.json or public/models. `apply: 'serve'` keeps it out of `astro build` entirely, and this file imports
// nothing from src/ at load time (the core is imported lazily by configureServer), so a build never touches local/.
//
// What it does:
//   1. a small HTTP API under /__local-save/ (logic in local-save-core.mjs) that reads and writes local/;
//   2. a `load` hook: the `src/data/scene.json?raw` and `src/data/models.json?raw` imports (admin, room pages, picker)
//      get the content of the local/ files instead of the committed ones (client and SSR environments alike);
//   3. a middleware for GET/HEAD /models/<id>.glb that serves local/models only (404 otherwise, never public/models,
//      whatever the spelling of the URL);
//   4. a `hotUpdate` hook: files the API just wrote do not reload the page (the admin keeps its pending imports,
//      selection, camera ...), a hand edit of local/scene.json or local/models.json reloads like an edit of the
//      committed file used to.
//
// The READ side (1 minus the writes, 2, 3) is always on while serving; only the write API (1) is switched off when the dev
// server is reachable beyond localhost. Dev never falls back to the committed data.
//
// Changes to this file or the core need a restart of `npm run dev` (they are imported by astro.config.mjs).
import { realpathSync } from 'node:fs';
import path from 'node:path';

const PREFIX = '/__local-save/';
const MARK_TTL_MS = 5000;
/** A client that sends nothing for this long during an upload is dropped. */
const BODY_IDLE_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** @param {string} file absolute path -> the form Vite hands to hotUpdate (forward slashes) */
const normalize = (file) => path.resolve(file).split(path.sep).join('/');

/** The two committed data files whose `?raw` imports are served from local/ instead (and the local twin of each). */
const DATA = {
	scene: { committed: ['src', 'data', 'scene.json'], local: ['local', 'scene.json'] },
	models: { committed: ['src', 'data', 'models.json'], local: ['local', 'models.json'] },
};
const GLB_URL_RE = /^\/models\/([^/]+)\.glb$/;

function sendText(res, status, text) {
	res.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Content-Length': Buffer.byteLength(text),
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
	});
	res.end(text);
}

function sendJson(res, status, body, extraHeaders = {}) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(text),
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		...extraHeaders,
	});
	res.end(text);
}

/** Reads the request body, giving up (413) as soon as it is larger than `limit` bytes. */
function readBody(req, limit, LocalSaveError) {
	return new Promise((resolve, reject) => {
		const declared = req.headers['content-length'];
		if (declared !== undefined && Number(declared) > limit) {
			reject(new LocalSaveError(413, 'too-large', 'The request body is too large.'));
			return;
		}
		const chunks = [];
		let size = 0;
		let done = false;
		let idle;
		const finish = (fn, value) => {
			if (done) return;
			done = true;
			clearTimeout(idle);
			fn(value);
		};
		const armIdle = () => {
			clearTimeout(idle);
			idle = setTimeout(() => {
				chunks.length = 0;
				finish(reject, new LocalSaveError(408, 'bad-request', 'The upload stalled and was dropped.'));
			}, BODY_IDLE_MS);
		};
		armIdle();
		req.on('data', (chunk) => {
			if (done) return;
			size += chunk.length;
			if (size > limit) {
				chunks.length = 0;
				req.pause();
				finish(reject, new LocalSaveError(413, 'too-large', 'The request body is too large.'));
				return;
			}
			chunks.push(chunk);
			armIdle();
		});
		req.on('end', () => finish(resolve, Buffer.concat(chunks, size)));
		req.on('error', (error) => finish(reject, error));
		req.on('aborted', () => finish(reject, new LocalSaveError(400, 'bad-request', 'The request was aborted.')));
	});
}

export default function localSavePlugin() {
	/** absolute path (normalized) -> time until which a change event for it is "ours" */
	const marks = new Map();
	const mark = (file) => {
		const now = Date.now();
		for (const [key, until] of marks) if (until < now) marks.delete(key);
		marks.set(normalize(file), now + MARK_TTL_MS);
	};
	const isMarked = (file) => {
		const until = marks.get(normalize(file));
		return until !== undefined && until >= Date.now();
	};
	let logger = null;
	const lastLogged = new Map();
	/** Repository root of the serving dev server; set by `setup` (configResolved / configureServer). */
	let rootDir = null;
	/** The dev server's SSR module runner (validators are loaded through it), set by configureServer. */
	let ssrRunner = null;
	/** normalized committed file (under the configured root and under its real path) -> 'scene' | 'models' */
	const committedKinds = new Map();
	/** normalized local file -> the committed twin's absolute path */
	const localTwins = new Map();
	let readyPromise = null;

	/** Records the root and which module ids / watcher paths are the data files. Idempotent. */
	const setup = (root, log) => {
		logger = log ?? logger;
		if (rootDir === root) return;
		rootDir = root;
		let realRootDir = root;
		try {
			realRootDir = realpathSync(root);
		} catch {
			// keep the configured root
		}
		committedKinds.clear();
		localTwins.clear();
		for (const base of new Set([root, realRootDir])) {
			for (const [kind, files] of Object.entries(DATA)) {
				const committed = path.join(base, ...files.committed);
				committedKinds.set(normalize(committed), kind);
				localTwins.set(normalize(path.join(base, ...files.local)), committed);
			}
		}
	};

	/** The scene rules are loaded through the dev server's own module runner on every use, so they follow hot updates. */
	const loadModule = async (rel) => {
		if (ssrRunner && typeof ssrRunner.import === 'function') {
			try {
				return await ssrRunner.import(path.join(rootDir, rel));
			} catch (error) {
				logger?.warn(`[local-save] could not load ${rel} through the dev server (${error instanceof Error ? error.message : String(error)}); using the copy loaded at start-up.`);
			}
		}
		// the copy next to this plugin (the repo the server runs in; `root` may be a test's temp dir)
		return import(new URL(`../${rel}`, import.meta.url).href);
	};

	/** The core and its store, created on first use (so nothing from src/ loads unless the dev server runs). */
	const getReady = () =>
		(readyPromise ??= import('./local-save-core.mjs').then((core) => ({
			core,
			store: core.createLocalSave({
				root: rootDir,
				onWrite: mark,
				slugs: async () => (await loadModule('src/data/family.ts')).family.map((member) => member.slug),
				validators: async () => {
					const [scene, modelFile] = await Promise.all([loadModule('src/data/scene.ts'), loadModule('src/scripts/admin/model-file.ts')]);
					return {
						validateScene: scene.validateScene,
						parseScene: scene.parseScene,
						parseModels: scene.parseModels,
						modelIdOf: scene.modelIdOf,
						validateGlb: modelFile.validateGlb,
						maxModelBytes: modelFile.MAX_MODEL_BYTES,
					};
				},
			}),
		})));

	/** 'scene' | 'models' when `id` is `<root>/src/data/{scene,models}.json` with a `raw` query, else null. */
	const rawKind = (id) => {
		const q = id.indexOf('?');
		if (q < 0 || !/(?:^|&)raw(?:&|=|$)/.test(id.slice(q + 1))) return null;
		return committedKinds.get(normalize(id.slice(0, q))) ?? null;
	};

	/**
	 * Every spelling by which Vite's public-dir middleware could end up at a file under public/models: the URL as sent, after
	 * decodeURI (what it does), and after decodeURIComponent (what sirv does), each normalised the way Vite normalises
	 * (`path.posix.normalize`, which also folds `//` and `/./`). True when any of them is under /models/.
	 */
	const underModels = (cleanPath) => {
		const candidates = [cleanPath];
		if (cleanPath.includes('%')) {
			for (const decode of [decodeURI, decodeURIComponent]) {
				try {
					candidates.push(decode(cleanPath));
				} catch {
					// not decodable: Vite carries on with the undecoded path
				}
			}
		}
		return candidates.some((candidate) => {
			const folded = path.posix.normalize(candidate).toLowerCase();
			return folded === '/models' || folded.startsWith('/models/');
		});
	};

	return {
		name: 'alishly-local-save',
		apply: 'serve',
		// 'pre': the `load` hook has to see the `?raw` ids before Vite's own raw-file loader does.
		enforce: 'pre',

		configResolved(config) {
			if (config.command !== 'serve') return;
			setup(config.root, config.logger);
		},

		// Dev only (apply:'serve'): the committed scene.json / models.json are never read by the dev server; their `?raw`
		// imports (src/data/load-scene.ts, models.ts) get the local/ files. Runs for every environment (client, ssr).
		// There is no fallback: local/ is created here if it is missing, and if that is refused the load THROWS.
		async load(id) {
			if (rootDir === null) return null; // before configResolved/configureServer: not serving
			const kind = rawKind(id);
			if (kind === null) return null;
			const rel = kind === 'scene' ? 'local/scene.json' : 'local/models.json';
			// What reaches the browser's error overlay (possibly a LAN client) carries only a safe message / error code and the
			// repo-relative path; the full error (absolute paths) goes to the dev server log.
			const fail = (error) => {
				logger?.error(`[local-save] cannot read ${rel}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				const safe = error && error.name === 'LocalSaveError' ? error.message : typeof error?.code === 'string' ? `error ${error.code}` : 'unexpected error, see the dev server log';
				return new Error(`[local-save] cannot read ${rel}: ${safe}`);
			};
			let result;
			try {
				const { store } = await getReady();
				result = await store.readRaw(kind);
			} catch (error) {
				throw fail(error);
			}
			try {
				JSON.parse(result.text);
			} catch {
				logger?.warn(`[local-save] ${rel} is not valid JSON (hand edit?), so ${kind === 'scene' ? 'the rooms are built empty' : 'no models are available'} until it is fixed.`);
			}
			this.addWatchFile?.(result.abs);
			return { code: `export default ${JSON.stringify(result.text)};`, map: null };
		},

		configureServer(server) {
			if (server.config.command !== 'serve') return;
			setup(server.config.root, server.config.logger);
			ssrRunner = server.environments?.ssr?.runner ?? null;
			const { host, allowedHosts } = server.config.server;
			// Fail closed for WRITES: only the default loopback-only dev server may use the write API. Reading local/ stays on.
			const writesEnabled = !((host !== undefined && host !== false && !LOOPBACK_HOSTS.has(String(host))) || allowedHosts === true);
			if (!writesEnabled) {
				logger.warn('[local-save] write API disabled: the dev server is reachable beyond localhost (server.host / server.allowedHosts). Pages and models are still read from local/.');
			}

			const ready = getReady();
			ready.catch((error) => logger.error(`[local-save] failed to load: ${error instanceof Error ? error.message : String(error)}`));
			// local/ first (and its watchers), then the sweep of old temp files in it.
			ready
				.then(async ({ store }) => {
					await store.ensureLocal().then(
						(created) => {
							if (created.length > 0) logger.info(`[local-save] created ${created.join(', ')}`);
						},
						(error) => logger.error(`[local-save] ${error instanceof Error ? error.message : String(error)}`),
					);
					for (const kind of Object.keys(DATA)) server.watcher?.add(path.join(rootDir, ...DATA[kind].local));
					if (writesEnabled) {
						store.sweepStaleTemp().then(
							(removed) => removed.length > 0 && logger.info(`[local-save] removed stale temp files: ${removed.join(', ')}`),
							() => {},
						);
					}
				})
				.catch(() => {});

			// Registered synchronously, i.e. before Astro's own catch-all middleware (added by a returned post hook).
			server.middlewares.use(async (req, res, next) => {
				const rawUrl = req.url ?? '';
				if (!rawUrl.startsWith(PREFIX)) return next();
				if (!writesEnabled) {
					return sendJson(res, 403, { error: { kind: 'forbidden', message: 'The local save is disabled because the dev server is reachable beyond localhost (server.host / server.allowedHosts). Nothing was saved.' } });
				}
				let loaded;
				try {
					loaded = await ready;
				} catch {
					return sendJson(res, 500, { error: { kind: 'internal', message: 'The local save failed to load; see the dev server log.' } });
				}
				const { core, store } = loaded;
				const { LocalSaveError } = core;
				let closeAfter = false;
				try {
					const url = new URL(rawUrl, 'http://localhost');
					const route = url.pathname.slice(PREFIX.length);
					const method = req.method ?? 'GET';
					const localPort = req.socket.localPort ?? 0;
					const encrypted = Boolean(req.socket.encrypted);
					const guard = (op) => core.checkRequest({ op, headers: req.headers, localPort, encrypted });
					const only = (allowedMethod) => {
						if (method !== allowedMethod) {
							throw Object.assign(new LocalSaveError(405, 'bad-request', `Use ${allowedMethod}.`), { allow: allowedMethod });
						}
					};
					const pathParam = () => {
						const values = url.searchParams.getAll('path');
						if (values.length !== 1) throw new LocalSaveError(400, 'bad-request', 'Exactly one path parameter is required.');
						return values[0];
					};

					switch (route) {
						case 'ping':
							only('GET');
							guard('ping');
							return sendJson(res, 200, store.ping());
						case 'file':
							if (method === 'PUT') {
								guard('write');
								const rel = pathParam();
								// Limits and the model-id rule come from the live validators (reloaded per request), so a
								// raised cap or a changed id rule needs no restart. Called before the body is read, which is
								// why no fixed upper bound is needed for streaming; core clamps absurd values (HARD_MAX_FILE_BYTES).
								closeAfter = true; // a failure here leaves the body unread
								const limits = await store.limits();
								closeAfter = false;
								const info = limits.classify(rel);
								if (!info) throw new LocalSaveError(403, 'forbidden', 'This path is not one the local save may touch.');
								core.checkContentType(req.headers, info.kind === 'glb' ? 'octet' : 'json');
								const shas = url.searchParams.getAll('sha');
								if (shas.length > 1) throw new LocalSaveError(400, 'bad-request', 'At most one sha parameter.');
								closeAfter = true;
								const body = await readBody(req, limits.maxFileBytes, LocalSaveError);
								closeAfter = false;
								const result = await store.writeFile(rel, body, shas.length === 1 ? shas[0] : null);
								logger?.info(`[local-save] wrote ${rel} (${result.bytes} bytes)`);
								return sendJson(res, 200, { path: result.path, sha: result.sha, head: result.head });
							}
							only('GET');
							guard('read');
							return sendJson(res, 200, await store.readText(pathParam()));
						case 'blob-sha':
							only('GET');
							guard('read');
							return sendJson(res, 200, await store.blobSha(pathParam()));
						case 'head':
							only('GET');
							guard('read');
							// `differs`: banner info (local scene/models vs. the committed files), read-only.
							return sendJson(res, 200, { ...(await store.head()), differs: await store.differs() });
						case 'commit': {
							only('POST');
							guard('write');
							core.checkContentType(req.headers, 'octet');
							closeAfter = true;
							const limits = await store.limits(); // live cap, see the PUT route
							const body = await readBody(req, limits.maxCommitBody, LocalSaveError);
							closeAfter = false;
							const result = await store.commit(body);
							logger?.info(`[local-save] commit: wrote ${result.written.length}, deleted ${result.deleted.length}, unchanged ${result.unchanged.length}`);
							return sendJson(res, 200, result);
						}
						default:
							return sendJson(res, 404, { error: { kind: 'not-found', message: 'Unknown local-save route.' } });
					}
				} catch (error) {
					if (error instanceof LocalSaveError) {
						if (error.status >= 500 && error.cause) {
							logger?.error(`[local-save] ${error.message} ${error.cause instanceof Error ? error.cause.stack ?? error.cause.message : String(error.cause)}`);
						}
						const extra = {};
						if (error.allow) extra.Allow = error.allow;
						// An aborted upload leaves unread bytes on the connection: close it once the answer is out.
						if (closeAfter || error.kind === 'too-large') extra.Connection = 'close';
						sendJson(res, error.status, { error: { kind: error.kind, message: error.message, ...error.extra } }, extra);
						if (extra.Connection) res.once('finish', () => req.destroy());
						return;
					}
					logger?.error(`[local-save] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
					sendJson(res, 500, { error: { kind: 'internal', message: 'The local save failed (see the dev server log).' } });
				}
			});
			// GET/HEAD /models/<id>.glb: served from local/models ONLY. Anything that resolves under /models/ in ANY spelling
			// (%-escapes, `//models`, `/./models`, query strings) that is not exactly `/models/<id>.glb` is a 404, so the
			// committed public/models never answers in dev. Registered synchronously in configureServer, i.e. before Vite's
			// public-dir middleware (which folds those spellings into the same file).
			server.middlewares.use(async (req, res, next) => {
				const rawUrl = req.url ?? '';
				const cleanPath = rawUrl.replace(/[?#][\s\S]*$/, '');
				if (!underModels(cleanPath)) return next();
				const method = req.method ?? 'GET';
				if (method !== 'GET' && method !== 'HEAD') return next();
				let handle = null;
				try {
					const { store } = await ready;
					const match = GLB_URL_RE.exec(cleanPath); // the path exactly as sent: no decoding, no folding
					const opened = match ? await store.openGlb(match[1]) : null;
					if (!opened) return sendText(res, 404, 'Not found: dev serves models from local/models only.');
					handle = opened.handle;
					res.writeHead(200, {
						'Content-Type': 'model/gltf-binary',
						'Content-Length': opened.size,
						'Cache-Control': 'no-store',
						'X-Content-Type-Options': 'nosniff',
					});
					if (method === 'HEAD' || opened.size === 0) {
						res.end();
						return;
					}
					const stream = handle.createReadStream({ autoClose: true, start: 0, end: opened.size - 1 });
					handle = null; // the stream owns (and closes) it now
					stream.on('error', () => res.destroy());
					res.on('close', () => stream.destroy());
					stream.pipe(res);
				} catch (error) {
					if (error && error.name === 'LocalSaveError') {
						if (!res.headersSent) sendText(res, error.status, error.message);
						else res.destroy();
						return;
					}
					logger?.error(`[local-save] /models: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
					if (!res.headersSent) sendText(res, 500, 'The model could not be read (see the dev server log).');
					else res.destroy();
				} finally {
					if (handle) await handle.close().catch(() => {});
				}
			});
			logger.info(writesEnabled ? '[local-save] endpoint ready at /__local-save/' : '[local-save] reading local/ (write API off)');
		},

		// Runs once per environment (client, ssr, ...) for every watcher event.
		// - A file this plugin just wrote: invalidate the modules ourselves (so a manual refresh serves the new content)
		//   and return [] so neither Vite's own propagation nor Astro's `astro:hmr-reload` (order 'post', ignores an empty
		//   list) sends full-reload.
		// - local/scene.json and local/models.json have no module of their own: the modules are those of the committed
		//   twin (src/data/*.json, the `?raw` modules the `load` hook fills from local/). A HAND edit (not marked) hands
		//   those modules to Vite, so the pages reload exactly as an edit of the committed file used to.
		// - Any other file falls through (undefined) and behaves as before.
		hotUpdate: {
			order: 'pre',
			handler({ file, modules, timestamp }) {
				const environment = this.environment;
				const twin = rootDir !== null ? localTwins.get(normalize(file)) : undefined;
				let affected = modules;
				if (twin !== undefined) {
					const twinModules = environment.moduleGraph.getModulesByFile(twin);
					if (twinModules && twinModules.size > 0) affected = [...new Set([...modules, ...twinModules])];
				}
				if (!isMarked(file)) return affected === modules ? undefined : affected;
				const seen = new Set();
				for (const mod of affected) environment.moduleGraph.invalidateModule(mod, seen, timestamp, true);
				// Environments with a module runner (Astro's SSR) cache evaluated modules separately.
				const evaluated = environment.runner?.evaluatedModules;
				if (evaluated) {
					for (const mod of seen) {
						if (mod.id == null) continue;
						const cached = evaluated.getModuleById(mod.id);
						if (cached) evaluated.invalidateModule(cached);
					}
				}
				if (logger && affected.length > 0) {
					const key = `${environment.name}:${normalize(file)}`;
					const now = Date.now();
					if ((lastLogged.get(key) ?? 0) + 1000 < now) {
						lastLogged.set(key, now);
						logger.info(`[local-save] ${environment.name}: no reload for ${path.basename(file)} (written by /admin)`);
					}
				}
				return [];
			},
		},
	};
}
