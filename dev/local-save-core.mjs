// Core of the dev-only "local save" endpoint (see dev/local-save-plugin.mjs): everything that can be tested
// without Vite. Node built-ins only; the repository's own pure modules are imported so the server applies
// exactly the rules the admin applies (validateScene / parseModels / validateGlb / MAX_MODEL_BYTES).
//
// This file is loaded by the dev server (and by `node --test`), never by `astro build` and never by the browser.
// The .ts imports rely on Node's built-in type stripping (the same way tests/*.test.ts load them).
//
// Nothing here talks HTTP except `checkRequest` / `checkContentType`, which only look at header objects.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseModels, parseScene, validateScene, modelIdOf } from '../src/data/scene.ts';
import { MAX_MODEL_BYTES, validateGlb } from '../src/scripts/admin/model-file.ts';

export const SERVICE = 'alishly-local-save';
export const API_VERSION = 1;
/** URL prefix of the endpoint. */
export const PREFIX = '/__local-save/';
/** Request header every call except `ping` must carry (forces a CORS preflight for cross-origin pages). */
export const GUARD_HEADER = 'x-alishly-local-save';
export const GUARD_VALUE = '1';

export const SCENE_PATH = 'src/data/scene.json';
export const MODELS_PATH = 'src/data/models.json';
export const MODELS_DIR = 'public/models';

/** Largest single file (scene, models.json or a .glb): the existing model cap. */
export const MAX_FILE_BYTES = MAX_MODEL_BYTES;
/** Largest commit body. Same "4 x cap" the model library uses for the files picked in one import. */
export const MAX_COMMIT_BYTES = 4 * MAX_MODEL_BYTES;
/**
 * Absolute ceiling for the live cap (see `validators().maxModelBytes`). Bodies are buffered in memory, so a typo like
 * 25_000_000_000 in model-file.ts must not turn the endpoint into a memory bomb. Far above any sane model size.
 */
export const HARD_MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_COMMIT_HEADER_BYTES = 64 * 1024;
const MAX_COMMIT_CHANGES = 64;

const SHA_RE = /^[0-9a-f]{40}$/;
const GLB_PATH_RE = /^public\/models\/([^/\\\0]+)\.glb$/;
const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/;

/** An error with an HTTP status and a machine-readable kind. `message` is safe to show to the user. */
export class LocalSaveError extends Error {
	/**
	 * @param {number} status
	 * @param {'bad-request'|'forbidden'|'not-found'|'conflict'|'rejected'|'too-large'|'unsupported-media'|'internal'} kind
	 * @param {string} message
	 * @param {Record<string, unknown>} [extra]
	 */
	constructor(status, kind, message, extra) {
		super(message);
		this.name = 'LocalSaveError';
		this.status = status;
		this.kind = kind;
		this.extra = extra;
	}
}

// --- Paths and ids ---------------------------------------------------------------------------------------

/**
 * Is `id` a model id? Uses `parseModels` itself (the rule that decides whether a models.json entry is kept and
 * that scene.json's `model:<id>` types follow) instead of copying its regular expression.
 */
export function isModelId(id, parse = parseModels) {
	if (typeof id !== 'string') return false;
	return parse([{ id, label: 'x', file: '/x', defaultScale: 1 }]).length === 1;
}

/**
 * What a repository path (exactly as the client writes it) refers to, or null when it is not allowed.
 * The allowlist is exact: the two data files and `public/models/<id>.glb`. No normalisation, no decoding.
 */
export function classifyPath(rel, parse = parseModels) {
	if (rel === SCENE_PATH) return { kind: 'scene', rel };
	if (rel === MODELS_PATH) return { kind: 'models', rel };
	if (typeof rel !== 'string') return null;
	const match = GLB_PATH_RE.exec(rel);
	if (match && isModelId(match[1], parse)) return { kind: 'glb', rel, id: match[1] };
	return null;
}

/** Same as classifyPath but throws a 403. */
function allowed(rel, parse) {
	const info = classifyPath(rel, parse);
	if (!info) throw new LocalSaveError(403, 'forbidden', 'This path is not one the local save may touch.');
	return info;
}

// --- Hashing ---------------------------------------------------------------------------------------------

/** Git blob sha1 of `bytes`: identical to `git hash-object` and to model-ops.ts `gitBlobSha`. */
export function gitBlobSha(bytes) {
	return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

// --- Request guard ---------------------------------------------------------------------------------------

/** Lower-cased header value; arrays (duplicates) are rejected by returning null. */
const header = (headers, name) => {
	const value = headers[name];
	return typeof value === 'string' ? value : null;
};

/**
 * Decides whether a request may be served. Throws a LocalSaveError(403) when not.
 *
 * - Host must be a loopback name with the server's own port (`localPort`), so a DNS-rebinding name never gets here.
 * - `Origin`, when sent, must be exactly `<scheme>://<that host>`. Writes REQUIRE it (browsers always send it on
 *   PUT/POST), so curl and cross-site forms cannot write.
 * - `Sec-Fetch-Site`, when sent, must be `same-origin` (reads also accept `none`).
 * - The custom header is required for everything except `ping`.
 *
 * @param {{ op: 'ping'|'read'|'write', headers: Record<string, string|string[]|undefined>, localPort: number, encrypted?: boolean }} args
 */
export function checkRequest({ op, headers, localPort, encrypted = false }) {
	const forbid = (why) => {
		throw new LocalSaveError(403, 'forbidden', why);
	};
	const host = header(headers, 'host');
	const match = host === null ? null : LOOPBACK_HOST_RE.exec(host);
	if (!match) forbid('Unexpected Host header.');
	const defaultPort = encrypted ? 443 : 80;
	const port = match[2] === undefined ? defaultPort : Number(match[2]);
	if (port !== localPort) forbid('Unexpected Host header.');
	const ownOrigin = `${encrypted ? 'https' : 'http'}://${host}`;

	const origin = headers.origin;
	if (origin !== undefined) {
		if (typeof origin !== 'string' || origin !== ownOrigin) forbid('Cross-origin request refused.');
	} else if (op === 'write') {
		forbid('A same-origin request (with an Origin header) is required.');
	}

	const site = headers['sec-fetch-site'];
	if (site !== undefined) {
		const okSite = site === 'same-origin' || (op !== 'write' && site === 'none');
		if (!okSite) forbid('Cross-site request refused.');
	}

	if (op !== 'ping' && header(headers, GUARD_HEADER) !== GUARD_VALUE) forbid(`The ${GUARD_HEADER} header is required.`);
}

/**
 * Content-Type check. 'json' = application/json (optionally ;charset=utf-8); 'octet' = application/octet-stream
 * with no parameters. Anything else is a 415, which also keeps simple (no-preflight) cross-site types out.
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {'json'|'octet'} expected
 */
export function checkContentType(headers, expected) {
	const raw = header(headers, 'content-type');
	const ok =
		raw !== null &&
		(expected === 'octet'
			? raw.trim().toLowerCase() === 'application/octet-stream'
			: /^application\/json\s*(?:;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(raw.trim()));
	if (!ok) {
		throw new LocalSaveError(415, 'unsupported-media', `Content-Type must be ${expected === 'octet' ? 'application/octet-stream' : 'application/json'}.`);
	}
}

// --- Payload validation ----------------------------------------------------------------------------------

const decodeUtf8 = (bytes, what) => {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new LocalSaveError(422, 'rejected', `${what} is not valid UTF-8 text.`);
	}
};

const parseJson = (text, what) => {
	try {
		return JSON.parse(text);
	} catch {
		throw new LocalSaveError(422, 'rejected', `${what} is not valid JSON.`);
	}
};

/** Throws a 422 unless `bytes` is acceptable content for the allowlisted file `info`. */
function validateContent(info, bytes, slugs, v, maxFile) {
	if (bytes.byteLength > maxFile) {
		throw new LocalSaveError(413, 'too-large', `The file is larger than the ${maxFile / (1024 * 1024)} MB limit.`);
	}
	if (info.kind === 'scene') {
		const raw = parseJson(decodeUtf8(bytes, 'The scene'), 'The scene');
		const problems = v.validateScene(raw, { slugs });
		if (problems.length > 0) throw new LocalSaveError(422, 'rejected', `The scene is not valid: ${problems.slice(0, 3).join('; ')}`);
	} else if (info.kind === 'models') {
		const raw = parseJson(decodeUtf8(bytes, 'models.json'), 'models.json');
		if (!Array.isArray(raw) || v.parseModels(raw).length !== raw.length) {
			throw new LocalSaveError(422, 'rejected', 'models.json has entries that cannot be read, so it was not written.');
		}
	} else {
		try {
			v.validateGlb(bytes);
		} catch (error) {
			throw new LocalSaveError(422, 'rejected', error instanceof Error ? error.message : 'The model file is not valid.');
		}
	}
}

// --- Commit body framing ---------------------------------------------------------------------------------

/** Largest commit body for a per-file cap: 4 files of that size plus the framing (same "4 x cap" as the model library). */
const commitBodyLimit = (maxFile) => 4 * maxFile + MAX_COMMIT_HEADER_BYTES + 4;

/**
 * Body of POST commit: `uint32 BE header length`, a UTF-8 JSON header, then the bytes of every `write` change
 * back to back in header order.
 *   header = { expectedHead: <40 hex>, changes: [ { path, op: 'write', size } | { path, op: 'delete' } ] }
 */
export function parseCommitBody(buffer, parse = parseModels, maxFile = MAX_FILE_BYTES) {
	const bad = (why) => new LocalSaveError(400, 'bad-request', `Malformed commit body: ${why}`);
	if (buffer.byteLength > commitBodyLimit(maxFile)) throw new LocalSaveError(413, 'too-large', 'The commit is too large.');
	if (buffer.byteLength < 4) throw bad('too short');
	const headerLength = buffer.readUInt32BE(0);
	if (headerLength === 0 || headerLength > MAX_COMMIT_HEADER_BYTES || 4 + headerLength > buffer.byteLength) throw bad('bad header length');
	let parsed;
	try {
		parsed = JSON.parse(decodeUtf8(buffer.subarray(4, 4 + headerLength), 'The commit header'));
	} catch (error) {
		if (error instanceof LocalSaveError) throw bad('header is not UTF-8 JSON');
		throw bad('header is not JSON');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw bad('header is not an object');
	const keys = Object.keys(parsed);
	if (keys.some((key) => key !== 'expectedHead' && key !== 'changes')) throw bad('unknown header field');
	if (typeof parsed.expectedHead !== 'string' || !SHA_RE.test(parsed.expectedHead)) throw bad('expectedHead must be a head token');
	if (!Array.isArray(parsed.changes) || parsed.changes.length === 0 || parsed.changes.length > MAX_COMMIT_CHANGES) throw bad('changes must be a non-empty list');

	const seen = new Set();
	const changes = [];
	let offset = 4 + headerLength;
	for (const item of parsed.changes) {
		if (typeof item !== 'object' || item === null || Array.isArray(item)) throw bad('a change is not an object');
		const info = classifyPath(item.path, parse);
		if (!info) throw new LocalSaveError(403, 'forbidden', 'This path is not one the local save may touch.');
		if (seen.has(item.path)) throw new LocalSaveError(422, 'rejected', 'The same file appears twice in the commit.');
		seen.add(item.path);
		const extra = Object.keys(item).filter((key) => key !== 'path' && key !== 'op' && key !== 'size');
		if (extra.length > 0) throw bad('unknown change field');
		if (item.op === 'delete') {
			if (item.size !== undefined) throw bad('a delete has no size');
			if (info.kind !== 'glb') throw new LocalSaveError(422, 'rejected', 'Only model files can be deleted.');
			changes.push({ ...info, op: 'delete' });
		} else if (item.op === 'write') {
			const { size } = item;
			if (!Number.isSafeInteger(size) || size < 0) throw bad('a write needs an integer size');
			if (size > maxFile) throw new LocalSaveError(413, 'too-large', `A file is larger than the ${maxFile / (1024 * 1024)} MB limit.`);
			if (offset + size > buffer.byteLength) throw bad('data is shorter than the sizes say');
			changes.push({ ...info, op: 'write', bytes: buffer.subarray(offset, offset + size) });
			offset += size;
		} else {
			throw bad('op must be "write" or "delete"');
		}
	}
	if (offset !== buffer.byteLength) throw bad('data is longer than the sizes say');
	return { expectedHead: parsed.expectedHead, changes };
}

// --- The store -------------------------------------------------------------------------------------------

const DEFAULT_VALIDATORS = { validateScene, parseScene, parseModels, modelIdOf, validateGlb };
/** Our own temp files: `.<name>.<12 hex>.tmp`. */
const TEMP_NAME_RE = {
	'src/data': /^\.(?:scene|models)\.json\.[0-9a-f]{12}\.tmp$/,
	[MODELS_DIR]: /^\.([^/\\]+)\.glb\.[0-9a-f]{12}\.tmp$/,
};
/** Live per-file cap from the validators (their MAX_MODEL_BYTES), clamped; the imported constant when absent/invalid. */
const capOf = (v) => {
	const n = v.maxModelBytes;
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), HARD_MAX_FILE_BYTES) : MAX_FILE_BYTES;
};
const STALE_TEMP_MS = 60 * 1000;

/**
 * @param {{
 *   root: string,
 *   slugs: readonly string[] | (() => readonly string[] | Promise<readonly string[]>),
 *   validators?: () => (typeof DEFAULT_VALIDATORS & { maxModelBytes?: number }) | Promise<typeof DEFAULT_VALIDATORS & { maxModelBytes?: number }>,
 *   onWrite?: (absPath: string) => void,
 * }} options
 *   `root` is the repository root (tests pass a temp dir). `slugs` are the room slugs scene.json is validated
 *   with, like the admin does. `validators` (optional) hands over { validateScene, parseScene, parseModels,
 *   modelIdOf, validateGlb, maxModelBytes? } afresh for every request, so a dev server can serve the CURRENT modules after hot
 *   updates; both `slugs` and `validators` may be functions for the same reason. Without `validators` the modules
 *   imported at the top of this file are used. `onWrite(absPath)` is called before and after every file the store
 *   touches (including its temp files), so the Vite plugin can tell its own writes from outside edits.
 */
export function createLocalSave(options) {
	const root = path.resolve(options.root);
	const onWrite = options.onWrite ?? (() => {});
	let slugs = typeof options.slugs === 'function' ? [] : options.slugs;
	let V = DEFAULT_VALIDATORS;
	/** Per-file cap in force for the current request (live `maxModelBytes` when the validators supply it). */
	let maxFile = MAX_FILE_BYTES;
	/** Called first by every public operation. A failure to load validators is a 500 with a plain message. */
	const refresh = async () => {
		try {
			if (options.validators) V = await options.validators();
			if (typeof options.slugs === 'function') slugs = await options.slugs();
			maxFile = capOf(V);
		} catch (error) {
			throw Object.assign(new LocalSaveError(500, 'internal', 'The local save could not load the scene rules (see the dev server log).'), { cause: error });
		}
	};

	let realRootPromise = null;
	const realRoot = () => (realRootPromise ??= realpath(root));

	const absOf = (rel) => {
		const abs = path.join(root, ...rel.split('/'));
		if (!abs.startsWith(root + path.sep)) throw new LocalSaveError(403, 'forbidden', 'This path is not one the local save may touch.');
		return abs;
	};

	/** lstat that returns null when the file does not exist. */
	const statOrNull = async (abs) => {
		try {
			return await lstat(abs);
		} catch (error) {
			if (error && error.code === 'ENOENT') return null;
			throw error;
		}
	};

	/** The directory must really be inside the repository (no symlinked directory) and the target a plain file. */
	const assertSafe = async (rel, abs) => {
		const dir = path.dirname(abs);
		let realDir;
		try {
			realDir = await realpath(dir);
		} catch (error) {
			if (error && error.code === 'ENOENT') return null; // directory missing: caller decides
			throw error;
		}
		const expected = path.join(await realRoot(), ...path.dirname(rel).split('/'));
		if (realDir !== expected) throw new LocalSaveError(403, 'forbidden', 'The target directory is not a plain directory inside the repository.');
		const stat = await statOrNull(abs);
		if (stat && !stat.isFile()) throw new LocalSaveError(403, 'forbidden', 'The target is not a regular file.');
		return stat;
	};

	/** Git blob sha of a file of any size (streamed). The upload cap does not apply to hashing what is already on disk. */
	const hashFile = (abs, size) =>
		new Promise((resolve, reject) => {
			const hash = createHash('sha1').update(`blob ${size}\0`);
			createReadStream(abs)
				.on('data', (chunk) => hash.update(chunk))
				.on('error', reject)
				.on('end', () => resolve(hash.digest('hex')));
		});
	// sha cache for .glb files only (scene.json / models.json are tiny and always re-hashed), keyed by size + mtime + inode
	const shaCache = new Map();
	const shaOfFile = async (rel) => {
		const abs = absOf(rel);
		const stat = await assertSafe(rel, abs);
		if (!stat) return null;
		if (!rel.endsWith('.glb')) return hashFile(abs, stat.size);
		const key = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
		const cached = shaCache.get(abs);
		if (cached && cached.key === key) return cached.sha;
		const sha = await hashFile(abs, stat.size);
		shaCache.set(abs, { key, sha });
		return sha;
	};

	/** Ids of the regular `public/models/<id>.glb` files on disk, sorted. */
	const listGlbIds = async () => {
		let entries;
		try {
			const dir = absOf(MODELS_DIR + '/x.glb');
			entries = await readdir(path.dirname(dir), { withFileTypes: true });
		} catch (error) {
			if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
			throw error;
		}
		const ids = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.glb')) continue;
			const id = entry.name.slice(0, -'.glb'.length);
			if (isModelId(id, V.parseModels)) ids.push(id);
		}
		return ids.sort();
	};

	const head = async () => {
		const ids = await listGlbIds();
		const lines = ['alishly-local-save head v1', `scene ${(await shaOfFile(SCENE_PATH)) ?? '-'}`, `models ${(await shaOfFile(MODELS_PATH)) ?? '-'}`];
		for (const id of ids) lines.push(`glb ${id} ${(await shaOfFile(`${MODELS_DIR}/${id}.glb`)) ?? '-'}`);
		return createHash('sha1').update(lines.join('\n')).digest('hex');
	};

	// All mutations run one after another, so a check and its write cannot interleave with another request.
	let queue = Promise.resolve();
	const serial = (fn) => {
		const run = queue.then(fn, fn);
		queue = run.catch(() => {});
		return run;
	};

	/** temp file in the same directory, fsync, rename over the target. */
	const atomicWrite = async (rel, bytes) => {
		const abs = absOf(rel);
		await mkdir(path.dirname(abs), { recursive: true });
		await assertSafe(rel, abs);
		const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
		onWrite(abs);
		onWrite(tmp);
		let renamed = false;
		try {
			const handle = await open(tmp, 'wx', 0o644);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(tmp, abs);
			renamed = true;
		} finally {
			if (!renamed) await unlink(tmp).catch(() => {});
			onWrite(tmp);
			onWrite(abs);
		}
		shaCache.delete(abs);
	};

	const removeFile = async (rel) => {
		const abs = absOf(rel);
		const stat = await assertSafe(rel, abs);
		if (!stat) return false;
		onWrite(abs);
		try {
			await unlink(abs);
		} finally {
			onWrite(abs);
		}
		shaCache.delete(abs);
		return true;
	};

	/** Removes temp files an earlier crash left behind (our naming pattern, older than a minute). */
	const sweepStaleTemp = async () => {
		const removed = [];
		for (const dir of Object.keys(TEMP_NAME_RE)) {
			let entries;
			try {
				// Same check as every write: a symlinked directory, or one resolving outside the repo, is not swept.
				await assertSafe(`${dir}/x`, absOf(`${dir}/x`));
				entries = await readdir(path.dirname(absOf(`${dir}/x`)), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const match = TEMP_NAME_RE[dir].exec(entry.name);
				if (!match || (dir === MODELS_DIR && !isModelId(match[1], V.parseModels))) continue;
				const rel = `${dir}/${entry.name}`;
				const abs = absOf(rel);
				try {
					const stat = await assertSafe(rel, abs); // lstat: a symlink or any non-file is refused
					if (!stat || Date.now() - stat.mtimeMs < STALE_TEMP_MS) continue;
					onWrite(abs);
					await unlink(abs);
					onWrite(abs);
					removed.push(`${dir}/${entry.name}`);
				} catch {
					// someone else got there first
				}
			}
		}
		return removed;
	};

	const checkSha = (value) => {
		if (value !== null && !SHA_RE.test(value)) throw new LocalSaveError(400, 'bad-request', 'sha must be a 40-character hex string.');
	};

	/** Text of scene.json or models.json with its blob sha. */
	const readText = async (rel) => {
		await refresh();
		const info = allowed(rel, V.parseModels);
		if (info.kind === 'glb') throw new LocalSaveError(403, 'forbidden', 'Model files are not served as text.');
		const abs = absOf(rel);
		const stat = await assertSafe(rel, abs);
		if (!stat) throw new LocalSaveError(404, 'not-found', 'The file does not exist.');
		if (stat.size > maxFile) throw new LocalSaveError(413, 'too-large', 'The file is larger than the limit.');
		const bytes = await readFile(abs);
		return { path: rel, text: decodeUtf8(bytes, 'The file'), sha: gitBlobSha(bytes) };
	};

	return {
		root,

		ping: () => ({ ok: true, service: SERVICE, version: API_VERSION }),

		readText,

		/** Git blob sha of an allowlisted file, or null when it does not exist. */
		async blobSha(rel) {
			await refresh();
			allowed(rel, V.parseModels);
			return { path: rel, sha: await shaOfFile(rel) };
		},

		head: async () => {
			await refresh();
			return { head: await head() };
		},

		sweepStaleTemp,

		/**
		 * The limits and path rule in force NOW (validators reloaded), for the HTTP layer to size its body reads:
		 * `maxFileBytes`, `maxCommitBody` (largest acceptable commit body) and `classify(rel)` (the allowlist with
		 * the live model-id rule). Reads nothing from the request, so it is safe to call before the body arrives.
		 */
		async limits() {
			await refresh();
			const parse = V.parseModels;
			return { maxFileBytes: maxFile, maxCommitBody: commitBodyLimit(maxFile), classify: (rel) => classifyPath(rel, parse) };
		},

		/**
		 * Replaces one allowlisted file. `expectedSha` = blob sha the caller last saw, or null to create the file;
		 * anything else on disk is a 409.
		 */
		async writeFile(rel, bytes, expectedSha) {
			await refresh();
			const info = allowed(rel, V.parseModels);
			checkSha(expectedSha);
			validateContent(info, bytes, slugs, V, maxFile);
			return serial(async () => {
				const current = await shaOfFile(rel);
				if (expectedSha === null ? current !== null : current !== expectedSha) {
					throw new LocalSaveError(409, 'conflict', 'The file on disk has changed since it was loaded.');
				}
				await atomicWrite(rel, bytes);
				return { path: rel, sha: gitBlobSha(bytes), head: await head(), bytes: bytes.byteLength };
			});
		},

		/**
		 * Several files in one request (see parseCommitBody). Order of writes: .glb files, scene.json (if present),
		 * models.json last; deletes of .glb files come after that, so a failure never leaves an entry whose file is gone.
		 */
		async commit(buffer) {
			await refresh();
			const { expectedHead, changes } = parseCommitBody(buffer, V.parseModels, maxFile);
			for (const change of changes) if (change.op === 'write') validateContent(change, change.bytes, slugs, V, maxFile);
			return serial(async () => {
				const current = await head();
				if (current !== expectedHead) throw new LocalSaveError(409, 'conflict', 'Files on disk have changed since they were loaded.');

				// A model may only be deleted when the scene as it will be after this commit no longer uses it.
				const deletes = changes.filter((change) => change.op === 'delete');
				if (deletes.length > 0) {
					const sceneWrite = changes.find((change) => change.op === 'write' && change.kind === 'scene');
					let sceneText;
					if (sceneWrite) {
						sceneText = decodeUtf8(sceneWrite.bytes, 'The scene');
					} else {
						try {
							sceneText = (await readText(SCENE_PATH)).text;
						} catch {
							throw new LocalSaveError(422, 'rejected', 'The scene on disk cannot be read, so no model was deleted.');
						}
					}
					const parsed = V.parseScene(parseJson(sceneText, 'The scene'), { slugs });
					if (!parsed.ok) throw new LocalSaveError(422, 'rejected', 'The scene on disk cannot be read, so no model was deleted.');
					for (const change of deletes) {
						const used = Object.values(parsed.scene.rooms).some((room) => room.objects.some((object) => V.modelIdOf(object.type) === change.id));
						if (used) throw new LocalSaveError(422, 'rejected', `The model "${change.id}" is still used in the scene, so it was not deleted.`);
					}
				}

				const written = [];
				const unchanged = [];
				const deleted = [];
				const rank = (change) => (change.kind === 'glb' ? 0 : change.kind === 'scene' ? 1 : 2);
				const writes = changes.filter((change) => change.op === 'write').sort((a, b) => rank(a) - rank(b));
				try {
					for (const change of writes) {
						if ((await shaOfFile(change.rel)) === gitBlobSha(change.bytes)) {
							unchanged.push(change.rel);
							continue;
						}
						await atomicWrite(change.rel, change.bytes);
						written.push(change.rel);
					}
					for (const change of deletes) if (await removeFile(change.rel)) deleted.push(change.rel);
				} catch (error) {
					if (error instanceof LocalSaveError) throw new LocalSaveError(error.status, error.kind, error.message, { written, deleted });
					// Only the error code goes to the client (Node's message holds absolute paths); the plugin logs `cause`.
					const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'error';
					throw Object.assign(new LocalSaveError(500, 'internal', `Writing to disk failed part-way (${code}). See the dev server log.`, { written, deleted }), { cause: error });
				}
				return { head: await head(), written, unchanged, deleted };
			});
		},
	};
}
