// DEV ONLY. A GithubClient (github.ts) that reads and writes the working tree through the dev server's
// /__local-save/ endpoint (dev/local-save-plugin.mjs) instead of GitHub. main.ts loads this file with a dynamic
// import() inside an `import.meta.env.DEV` branch, so it never reaches `dist`.
// Pure TypeScript with only erasable syntax and no DOM/three/Astro imports: Node can import it, `fetch` is injected.
//
// Mapping: getFile/getFileAt -> GET file, getBlobSha -> GET blob-sha, getHead -> GET head, putFile -> PUT file,
// commitFiles -> POST commit (one framed body). `sha` is a git blob sha1 and the "head" is an opaque token over
// scene.json + models.json + public/models, so the conflict handling of the GitHub flow works unchanged.
import type { Wording } from './backend.ts';
import { GithubError } from './github.ts';
import type { CommitFilesArgs, FetchLike, GithubClient, GithubErrorKind, PutResult, RemoteFile } from './github.ts';

export const LOCAL_BASE = '/__local-save/';
const GUARD_HEADER = 'X-Alishly-Local-Save';
const SCENE_PATH = 'src/data/scene.json';
const MAX_COMMIT_HEADER_BYTES = 64 * 1024;

export interface LocalClientOptions {
	fetch?: FetchLike;
	/** URL prefix of the endpoint; tests may pass an absolute one. */
	baseUrl?: string;
	timeoutMs?: number;
	uploadTimeoutMs?: number;
}

export const LOCAL_WORDING: Wording = {
	where: 'disk',
	loaded: 'Loaded the latest scene from disk (src/data/scene.json).',
	sceneSaved: 'Saved src/data/scene.json — commit & push to publish.',
	modelsUpToDate: 'The model library on disk was already up to date. Nothing was written.',
	modelAdded: (label) => `Added "${label}". Place it from "Add to room"; click Save models to write it to disk.`,
	modelsSaved: (summary) =>
		`Saved models${summary ? ` (${summary})` : ''} to public/models and src/data/models.json — commit & push to publish.`,
	ready: 'Dev: saving to disk. "Load latest" re-reads src/data/scene.json.',
};

export type ProbeResult = { ok: true } | { ok: false; message: string };

/** Is the local endpoint there and willing? Never throws; on failure `message` says why and what to do. */
export async function probeLocal(options: LocalClientOptions = {}): Promise<ProbeResult> {
	const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
	const restart = 'Restart `npm run dev` if the plugin was just added.';
	try {
		let response: Response;
		try {
			response = await doFetch(`${options.baseUrl ?? LOCAL_BASE}ping`, { signal: controller.signal, cache: 'no-store' });
		} catch {
			return { ok: false, message: `Local save: the dev server did not answer. Is \`npm run dev\` still running? Nothing was saved.` };
		}
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			// not JSON (e.g. Astro's HTML 404 page)
		}
		const serverMessage = (typeof body === 'object' && body !== null ? (body as { error?: { message?: unknown } }).error?.message : undefined) ?? '';
		const detail = typeof serverMessage === 'string' && serverMessage ? ` (${serverMessage})` : '';
		if (response.status === 404) {
			return { ok: false, message: `Local save is not available: the dev server has no /__local-save/ endpoint. ${restart} If it is still missing, the dev server may be running with --host (the plugin only serves localhost); see the dev server log. Nothing was saved.` };
		}
		if (response.status === 403) {
			return { ok: false, message: `Local save refused the request${detail}. Open the admin as http://localhost:<port>/admin, not through another host or port. Nothing was saved.` };
		}
		if (!response.ok) {
			return { ok: false, message: `Local save has a problem${detail} (HTTP ${response.status}). Check the dev server log. ${restart} Nothing was saved.` };
		}
		if (typeof body !== 'object' || body === null || (body as { service?: unknown }).service !== 'alishly-local-save') {
			return { ok: false, message: 'Local save sent an unexpected answer. Is another server running on this port? Nothing was saved.' };
		}
		return { ok: true };
	} finally {
		clearTimeout(timer);
	}
}

/** Is the local endpoint there? Never throws. */
export async function pingLocal(options: LocalClientOptions = {}): Promise<boolean> {
	return (await probeLocal(options)).ok;
}

/** HTTP status / server kind -> the GithubError kind the admin already knows how to show. */
function mapError(status: number, body: unknown): GithubError {
	const detail = (typeof body === 'object' && body !== null ? (body as { error?: { kind?: unknown; message?: unknown } }).error : undefined) ?? {};
	const message = typeof detail.message === 'string' && detail.message ? detail.message : `The local save answered HTTP ${status}.`;
	let kind: GithubErrorKind;
	if (status === 409) kind = 'conflict';
	else if (status === 404) kind = 'not-found';
	else if (status === 403 || status === 413 || status === 415 || status === 422) kind = 'rejected';
	else if (status >= 500) kind = 'server';
	else kind = 'bad-response';
	return new GithubError(kind, message, status);
}

export function createLocalClient(options: LocalClientOptions = {}): GithubClient {
	const base = options.baseUrl ?? LOCAL_BASE;
	const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const timeoutMs = options.timeoutMs ?? 30000;
	const uploadTimeoutMs = options.uploadTimeoutMs ?? 120000;

	async function call(route: string, init: RequestInit & { headers?: Record<string, string> }, timeout: number): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		let response: Response;
		try {
			response = await doFetch(`${base}${route}`, {
				...init,
				cache: 'no-store',
				headers: { [GUARD_HEADER]: '1', ...init.headers },
				signal: controller.signal,
			});
		} catch {
			if (controller.signal.aborted) throw new GithubError('timeout', 'The local save did not answer in time.');
			throw new GithubError('network', 'Could not reach the dev server\'s local save. Is `npm run dev` still running?');
		} finally {
			clearTimeout(timer);
		}
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			// not JSON: handled below
		}
		if (!response.ok) throw mapError(response.status, body);
		if (typeof body !== 'object' || body === null) throw new GithubError('bad-response', 'The local save sent an unreadable answer.', response.status);
		return body;
	}

	const query = (path: string, extra = '') => `path=${encodeURIComponent(path)}${extra}`;

	async function readFile(path: string): Promise<RemoteFile> {
		const body = (await call(`file?${query(path)}`, { method: 'GET' }, timeoutMs)) as { text?: unknown; sha?: unknown };
		if (typeof body.text !== 'string' || typeof body.sha !== 'string') throw new GithubError('bad-response', 'The local save sent an unreadable file.');
		return { text: body.text, sha: body.sha };
	}

	async function readHead(): Promise<string> {
		const body = (await call('head', { method: 'GET' }, timeoutMs)) as { head?: unknown };
		if (typeof body.head !== 'string') throw new GithubError('bad-response', 'The local save sent an unreadable head.');
		return body.head;
	}

	return {
		getFile: () => readFile(SCENE_PATH),

		// The ref is the head token of getHead(); the endpoint always serves the working tree, and the caller's
		// expectedHead on commitFiles catches anything that changed in between.
		getFileAt: (path, _ref) => readFile(path),

		async getBlobSha(path, _ref) {
			const body = (await call(`blob-sha?${query(path)}`, { method: 'GET' }, timeoutMs)) as { sha?: unknown };
			if (body.sha === null) return null;
			if (typeof body.sha !== 'string') throw new GithubError('bad-response', 'The local save sent an unreadable sha.');
			return body.sha;
		},

		getHead: readHead,

		async putFile({ text, sha }): Promise<PutResult> {
			const extra = sha ? `&sha=${encodeURIComponent(sha)}` : '';
			const body = (await call(
				`file?${query(SCENE_PATH, extra)}`,
				{ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(text) },
				timeoutMs,
			)) as { sha?: unknown };
			if (typeof body.sha !== 'string') throw new GithubError('bad-response', 'The local save sent an unreadable answer.');
			return { sha: body.sha, commitSha: null };
		},

		async commitFiles({ changes, expectedHead }: CommitFilesArgs) {
			const head = expectedHead ?? (await readHead());
			const encoder = new TextEncoder();
			const parts: Uint8Array[] = [];
			const described = changes.map((change) => {
				if ('delete' in change) return { path: change.path, op: 'delete' as const };
				const bytes = 'text' in change ? encoder.encode(change.text) : change.bytes;
				parts.push(bytes);
				return { path: change.path, op: 'write' as const, size: bytes.byteLength };
			});
			const header = encoder.encode(JSON.stringify({ expectedHead: head, changes: described }));
			if (header.byteLength > MAX_COMMIT_HEADER_BYTES) throw new GithubError('rejected', 'Too many files in one save.');
			const total = 4 + header.byteLength + parts.reduce((sum, part) => sum + part.byteLength, 0);
			const body = new Uint8Array(total);
			new DataView(body.buffer).setUint32(0, header.byteLength, false);
			body.set(header, 4);
			let offset = 4 + header.byteLength;
			for (const part of parts) {
				body.set(part, offset);
				offset += part.byteLength;
			}
			const answer = (await call('commit', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }, uploadTimeoutMs)) as {
				head?: unknown;
			};
			if (typeof answer.head !== 'string') throw new GithubError('bad-response', 'The local save sent an unreadable answer.');
			return { commitSha: answer.head };
		},
	};
}
