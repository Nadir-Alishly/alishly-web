// Dev-only Vite plugin: lets /admin save scene.json, models.json and public/models/<id>.glb straight to disk
// while `npm run dev` runs. `apply: 'serve'` keeps it out of `astro build` entirely, and this file imports
// nothing from src/ at load time (the core is imported lazily by configureServer), so a build never touches it.
//
// What it does:
//   1. a small HTTP API under /__local-save/ (documented in the task report; logic in local-save-core.mjs);
//   2. a `hotUpdate` hook that recognises files the API just wrote and swallows the resulting HMR event, so the
//      admin page is not reloaded (losing pending imports, selection, camera ...) after its own Save.
//
// Changes to this file or the core need a restart of `npm run dev` (they are imported by astro.config.mjs).
import path from 'node:path';

const PREFIX = '/__local-save/';
const MARK_TTL_MS = 5000;
/** A client that sends nothing for this long during an upload is dropped. */
const BODY_IDLE_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** @param {string} file absolute path -> the form Vite hands to hotUpdate (forward slashes) */
const normalize = (file) => path.resolve(file).split(path.sep).join('/');

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

	return {
		name: 'alishly-local-save',
		apply: 'serve',

		configureServer(server) {
			if (server.config.command !== 'serve') return;
			logger = server.config.logger;
			const { host, allowedHosts } = server.config.server;
			// Fail closed: only the default loopback-only dev server is supported.
			if ((host !== undefined && host !== false && !LOOPBACK_HOSTS.has(String(host))) || allowedHosts === true) {
				logger.warn('[local-save] disabled: the dev server is reachable beyond localhost (server.host / server.allowedHosts).');
				return;
			}

			// Imported lazily (and eagerly started) so nothing from src/ is loaded unless the dev server runs.
			const rootDir = server.config.root;
			// The scene rules (scene.ts, model-file.ts, family.ts) are loaded through the dev server's own module
			// runner on every request, so they follow hot updates (a new room or limit needs no restart). Without a
			// runner (tests, odd setups) the natively imported copies are used.
			const runner = server.environments?.ssr?.runner;
			const load = async (rel) => {
				if (runner && typeof runner.import === 'function') {
					try {
						return await runner.import(path.join(rootDir, rel));
					} catch (error) {
						logger.warn(`[local-save] could not load ${rel} through the dev server (${error instanceof Error ? error.message : String(error)}); using the copy loaded at start-up.`);
					}
				}
				// the copy next to this plugin (the repo the server runs in; `root` may be a test's temp dir)
				return import(new URL(`../${rel}`, import.meta.url).href);
			};
			const ready = import('./local-save-core.mjs').then(async (core) => {
				const store = core.createLocalSave({
					root: rootDir,
					onWrite: mark,
					slugs: async () => (await load('src/data/family.ts')).family.map((member) => member.slug),
					validators: async () => {
						const [scene, modelFile] = await Promise.all([load('src/data/scene.ts'), load('src/scripts/admin/model-file.ts')]);
						return {
							validateScene: scene.validateScene,
							parseScene: scene.parseScene,
							parseModels: scene.parseModels,
							modelIdOf: scene.modelIdOf,
							validateGlb: modelFile.validateGlb,
							maxModelBytes: modelFile.MAX_MODEL_BYTES,
						};
					},
				});
				store.sweepStaleTemp().then(
					(removed) => removed.length > 0 && logger.info(`[local-save] removed stale temp files: ${removed.join(', ')}`),
					() => {},
				);
				return { core, store };
			});
			ready.catch((error) => logger.error(`[local-save] failed to load: ${error instanceof Error ? error.message : String(error)}`));

			// Registered synchronously, i.e. before Astro's own catch-all middleware (added by a returned post hook).
			server.middlewares.use(async (req, res, next) => {
				const rawUrl = req.url ?? '';
				if (!rawUrl.startsWith(PREFIX)) return next();
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
							return sendJson(res, 200, await store.head());
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
			logger.info('[local-save] endpoint ready at /__local-save/');
		},

		// Runs once per environment (client, ssr, ...) for every watcher event. For a file this plugin just wrote:
		// invalidate the modules ourselves (so a manual refresh serves the new content) and return [] so neither
		// Vite's own propagation nor Astro's `astro:hmr-reload` (order 'post', ignores an empty list) sends full-reload.
		// Any other file, e.g. a hand edit of scene.json, falls through (undefined) and behaves as before.
		hotUpdate: {
			order: 'pre',
			handler({ file, modules, timestamp }) {
				if (!isMarked(file)) return;
				const environment = this.environment;
				const seen = new Set();
				for (const mod of modules) environment.moduleGraph.invalidateModule(mod, seen, timestamp, true);
				// Environments with a module runner (Astro's SSR) cache evaluated modules separately.
				const evaluated = environment.runner?.evaluatedModules;
				if (evaluated) {
					for (const mod of seen) {
						if (mod.id == null) continue;
						const cached = evaluated.getModuleById(mod.id);
						if (cached) evaluated.invalidateModule(cached);
					}
				}
				if (logger && modules.length > 0) {
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
