// GitHub contents API client for saving scene.json from /admin, plus the token/settings storage.
// Pure TypeScript with only erasable syntax and no DOM/three/Astro imports, so Node can import it
// directly. `fetch` and the Storage objects are injected, which is how it is tested.
//
// The token is only ever used as the value of the Authorization header. It is never put in a URL,
// a log line, an error message or a thrown value.

export interface GithubTarget {
	owner: string;
	repo: string;
	branch: string;
	path: string;
}

export const DEFAULT_TARGET: Readonly<GithubTarget> = {
	owner: 'Nadir-Alishly',
	repo: 'alishly-web',
	branch: 'main',
	path: 'src/data/scene.json',
};

export const API_BASE = 'https://api.github.com';
export const API_VERSION = '2022-11-28';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type GithubErrorKind =
	| 'invalid-config' // bad owner/repo/branch/path/token before any request
	| 'auth' // 401, or 403 without a rate limit: bad/expired token or missing permission
	| 'rate-limit' // 403/429 with the rate limit exhausted
	| 'not-found' // 404
	| 'conflict' // 409, or 422 about the sha: the file changed on GitHub since it was loaded (or the sha is missing)
	| 'rejected' // any other 422: GitHub refused the content/branch/request itself, so retrying or overwriting won't help
	| 'network' // fetch itself failed
	| 'timeout'
	| 'server' // 5xx
	| 'bad-response' // 2xx that does not look like a file
	| 'edited-meanwhile' // not from GitHub: the user changed the scene while a load was running
	| 'unknown';

export class GithubError extends Error {
	kind: GithubErrorKind;
	/** HTTP status, 0 when there was no response. */
	status: number;
	constructor(kind: GithubErrorKind, message: string, status = 0) {
		super(message);
		this.name = 'GithubError';
		this.kind = kind;
		this.status = status;
	}
}

// --- UTF-8 safe base64 ---------------------------------------------------------------------

/** `btoa` throws on anything above Latin-1, so go through UTF-8 bytes. */
export function encodeBase64Utf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** GitHub wraps its base64 every 60 characters, so whitespace is stripped before decoding. */
export function decodeBase64Utf8(base64: string): string {
	const binary = atob(base64.replace(/\s+/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// --- Target and URL --------------------------------------------------------------------------

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Returns the first problem with the settings, or null when they are usable. */
export function validateTarget(target: GithubTarget): string | null {
	if (!OWNER_RE.test(target.owner)) return 'Owner looks wrong (letters, digits and "-" only).';
	if (!REPO_RE.test(target.repo) || target.repo === '.' || target.repo === '..') {
		return 'Repository name looks wrong.';
	}
	const branch = target.branch;
	if (
		!branch ||
		/[\s~^:?*[\\]/.test(branch) ||
		branch.includes('..') ||
		branch.startsWith('/') ||
		branch.endsWith('/') ||
		branch.endsWith('.lock')
	) {
		return 'Branch name looks wrong.';
	}
	const path = target.path;
	if (
		!path ||
		path.startsWith('/') ||
		path.endsWith('/') ||
		path.includes('\\') ||
		path.split('/').some((part) => part === '' || part === '.' || part === '..')
	) {
		return 'File path looks wrong (relative path inside the repository, no "..").';
	}
	return null;
}

export function contentsUrl(target: GithubTarget, withRef: boolean): string {
	const path = target.path.split('/').map(encodeURIComponent).join('/');
	const base = `${API_BASE}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${path}`;
	return withRef ? `${base}?ref=${encodeURIComponent(target.branch)}` : base;
}

// --- Error mapping -----------------------------------------------------------------------------

/** Pulls GitHub's own `message` out of an error body, shortened. Never contains our token. */
function serverMessage(body: unknown): string {
	if (typeof body === 'object' && body !== null && 'message' in body) {
		const message = (body as { message: unknown }).message;
		if (typeof message === 'string') return message.replace(/\s+/g, ' ').trim().slice(0, 200);
	}
	return '';
}

/** Maps a failed HTTP response to a GithubError. `headers` may be undefined in mocks. */
export function mapHttpError(status: number, body: unknown, headers?: Headers | null): GithubError {
	const detail = serverMessage(body);
	const withDetail = (text: string) => (detail ? `${text} (GitHub said: ${detail})` : text);
	const rateLimited =
		(status === 403 || status === 429) &&
		(headers?.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail));

	if (rateLimited) {
		return new GithubError('rate-limit', withDetail('GitHub rate limit reached. Wait a bit and try again.'), status);
	}
	if (status === 401) {
		return new GithubError(
			'auth',
			withDetail('The token was rejected (invalid or expired). Paste a new one.'),
			status,
		);
	}
	if (status === 403) {
		return new GithubError(
			'auth',
			withDetail('The token is not allowed to do this. It needs "Contents: Read and write" on this repository.'),
			status,
		);
	}
	if (status === 404) {
		return new GithubError(
			'not-found',
			withDetail(
				'Not found. Check owner, repository, branch and path. A token without access to a private repository also gets this.',
			),
			status,
		);
	}
	// 409 is GitHub's "sha does not match". 422 is "sha wasn't supplied" but also covers refusals that an
	// overwrite cannot fix (protected branch, bad payload), so only a 422 that talks about the sha, or
	// has no message at all, counts as a conflict.
	if (status === 409 || (status === 422 && (!detail || /\bsha\b/i.test(detail)))) {
		return new GithubError(
			'conflict',
			withDetail('The file changed on GitHub since it was loaded (or its version is missing).'),
			status,
		);
	}
	if (status === 422) {
		return new GithubError('rejected', withDetail('GitHub refused this save.'), status);
	}
	if (status >= 500) {
		return new GithubError('server', withDetail('GitHub had a problem. Try again in a moment.'), status);
	}
	return new GithubError('unknown', withDetail(`Unexpected response from GitHub (HTTP ${status}).`), status);
}

/** One user-facing sentence for any thrown value. */
export function describeError(error: unknown): string {
	if (error instanceof GithubError) return error.message;
	return 'Something went wrong.';
}

// --- Client --------------------------------------------------------------------------------------

export interface GithubClientOptions {
	token: string;
	target: GithubTarget;
	/** Defaults to the global fetch, looked up at call time. */
	fetch?: FetchLike;
	timeoutMs?: number;
}

export interface RemoteFile {
	/** Decoded UTF-8 text. */
	text: string;
	/** Blob sha, to be sent with the next PUT. */
	sha: string;
}

export interface PutResult {
	/** New blob sha of the file: use it for the next save. */
	sha: string;
	commitSha: string | null;
}

export interface GithubClient {
	getFile(): Promise<RemoteFile>;
	/** `sha` is the blob sha from the last getFile/putFile; omit it only to create the file. */
	putFile(args: { text: string; message: string; sha?: string | null }): Promise<PutResult>;
}

const TOKEN_RE = /^[\x21-\x7e]+$/; // visible ASCII, no whitespace

export function createGithubClient(options: GithubClientOptions): GithubClient {
	const { token, target } = options;
	const timeoutMs = options.timeoutMs ?? 30000;
	const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

	const headers = (): Record<string, string> => ({
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': API_VERSION,
	});

	const preflight = () => {
		if (!TOKEN_RE.test(token)) throw new GithubError('invalid-config', 'Enter a token first.');
		const problem = validateTarget(target);
		if (problem) throw new GithubError('invalid-config', problem);
	};

	async function request(url: string, init: RequestInit): Promise<{ status: number; body: unknown; headers: Headers }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response: Response;
		try {
			response = await doFetch(url, { ...init, signal: controller.signal });
		} catch {
			// The caught value is deliberately not attached: nothing from the request may leak into messages.
			if (controller.signal.aborted) {
				throw new GithubError('timeout', 'GitHub did not answer in time. Check your connection and try again.');
			}
			throw new GithubError('network', 'Could not reach GitHub. Check your connection and try again.');
		} finally {
			clearTimeout(timer);
		}
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			body = null;
		}
		if (!response.ok) throw mapHttpError(response.status, body, response.headers);
		return { status: response.status, body, headers: response.headers };
	}

	return {
		async getFile() {
			preflight();
			const { body } = await request(contentsUrl(target, true), {
				method: 'GET',
				headers: headers(),
				cache: 'no-store',
			});
			const file = body as { type?: unknown; encoding?: unknown; content?: unknown; sha?: unknown } | null;
			if (!file || Array.isArray(file) || (file.type !== undefined && file.type !== 'file') || typeof file.sha !== 'string') {
				throw new GithubError('bad-response', 'That path is not a file on GitHub.');
			}
			if (file.encoding !== 'base64' || typeof file.content !== 'string') {
				throw new GithubError('bad-response', 'GitHub returned the file in a format this page cannot read.');
			}
			let text: string;
			try {
				text = decodeBase64Utf8(file.content);
			} catch {
				throw new GithubError('bad-response', 'The file on GitHub is not valid UTF-8 text.');
			}
			return { text, sha: file.sha };
		},

		async putFile({ text, message, sha }) {
			preflight();
			const payload: Record<string, string> = {
				message,
				content: encodeBase64Utf8(text),
				branch: target.branch,
			};
			if (sha) payload.sha = sha;
			const { body } = await request(contentsUrl(target, false), {
				method: 'PUT',
				headers: { ...headers(), 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const result = body as { content?: { sha?: unknown }; commit?: { sha?: unknown } } | null;
			const newSha = result?.content?.sha;
			if (typeof newSha !== 'string') {
				throw new GithubError('bad-response', 'GitHub accepted the save but sent an unexpected answer. Use "Load latest".');
			}
			const commitSha = typeof result?.commit?.sha === 'string' ? result.commit.sha : null;
			return { sha: newSha, commitSha };
		},
	};
}

// --- Token and settings storage ---------------------------------------------------------------------

export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export const TOKEN_KEY = 'alishly-admin-token';
export const TARGET_KEY = 'alishly-admin-target';

/** Reads the token: sessionStorage first, then localStorage ("Remember on this device"). */
export function loadToken(
	session: StorageLike | null,
	local: StorageLike | null,
): { token: string; remembered: boolean } {
	try {
		const fromSession = session?.getItem(TOKEN_KEY);
		if (fromSession) return { token: fromSession, remembered: false };
	} catch {
		// storage blocked: treat as empty
	}
	try {
		const fromLocal = local?.getItem(TOKEN_KEY);
		if (fromLocal) return { token: fromLocal, remembered: true };
	} catch {
		// storage blocked: treat as empty
	}
	return { token: '', remembered: false };
}

/** Stores the token in exactly one place: localStorage if `remember`, else sessionStorage. */
export function saveToken(
	token: string,
	remember: boolean,
	session: StorageLike | null,
	local: StorageLike | null,
): void {
	forgetToken(session, local);
	if (!token) return;
	try {
		(remember ? local : session)?.setItem(TOKEN_KEY, token);
	} catch {
		// quota/blocked: the token then lives in the input only
	}
}

export function forgetToken(session: StorageLike | null, local: StorageLike | null): void {
	for (const storage of [session, local]) {
		try {
			storage?.removeItem(TOKEN_KEY);
		} catch {
			// ignore
		}
	}
}

/** Owner/repo/branch/path are not secret; they live in localStorage. Bad stored values fall back to defaults. */
export function loadTarget(local: StorageLike | null): GithubTarget {
	try {
		const raw = local?.getItem(TARGET_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<Record<keyof GithubTarget, unknown>>;
			const target: GithubTarget = { ...DEFAULT_TARGET };
			for (const key of Object.keys(DEFAULT_TARGET) as (keyof GithubTarget)[]) {
				const value = parsed[key];
				if (typeof value === 'string') target[key] = value;
			}
			return target;
		}
	} catch {
		// fall through to defaults
	}
	return { ...DEFAULT_TARGET };
}

export function saveTarget(target: GithubTarget, local: StorageLike | null): void {
	try {
		local?.setItem(TARGET_KEY, JSON.stringify(target));
	} catch {
		// ignore
	}
}
