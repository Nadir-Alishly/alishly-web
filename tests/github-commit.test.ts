// Unit tests for the multi-file commit of src/scripts/admin/github.ts (commitFiles, getHead, getFileAt) with an
// injected fetch. No network. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubClient, DEFAULT_TARGET, GithubError, gitUrl, mapHttpError, encodeBase64Bytes, API_BASE } from '../src/scripts/admin/github.ts';
import type { FileChange } from '../src/scripts/admin/github.ts';

const TOKEN = 'test-token-not-real';
const TARGET = { ...DEFAULT_TARGET };
const REPO = `${API_BASE}/repos/${TARGET.owner}/${TARGET.repo}`;
const BRANCH = TARGET.branch;

interface Call { url: string; method: string; body: any; headers: Record<string, string>; signal?: AbortSignal }
type Handler = (call: Call) => { status?: number; body?: unknown; reject?: unknown } | undefined;

/** A fetch that records calls and answers like GitHub's Git Data API unless `override` returns something. */
function fakeGit(opts: { head?: string; override?: Handler } = {}) {
	const calls: Call[] = [];
	let blobs = 0;
	const fetch = async (url: string, init?: RequestInit) => {
		const call: Call = {
			url,
			method: init?.method ?? 'GET',
			body: init?.body ? JSON.parse(init.body as string) : undefined,
			headers: (init?.headers ?? {}) as Record<string, string>,
			signal: init?.signal ?? undefined,
		};
		calls.push(call);
		const o = opts.override?.(call);
		if (o?.reject !== undefined) throw o.reject;
		let status = o?.status ?? 200;
		let body: unknown = o?.body;
		if (!o) {
			const head = opts.head ?? 'head-sha';
			if (call.method === 'GET' && url === `${REPO}/git/ref/heads/${BRANCH}`) body = { ref: `refs/heads/${BRANCH}`, object: { sha: head, type: 'commit' } };
			else if (call.method === 'GET' && url === `${REPO}/git/commits/${head}`) body = { sha: head, tree: { sha: 'base-tree-sha' } };
			else if (call.method === 'POST' && url === `${REPO}/git/blobs`) { status = 201; body = { sha: `blob-${++blobs}` }; }
			else if (call.method === 'POST' && url === `${REPO}/git/trees`) { status = 201; body = { sha: 'new-tree-sha' }; }
			else if (call.method === 'POST' && url === `${REPO}/git/commits`) { status = 201; body = { sha: 'new-commit-sha' }; }
			else if (call.method === 'PATCH' && url === `${REPO}/git/refs/heads/${BRANCH}`) body = { ref: `refs/heads/${BRANCH}`, object: { sha: 'new-commit-sha' } };
			else { status = 404; body = { message: `unexpected ${call.method} ${url}` }; }
		}
		return new Response(JSON.stringify(body ?? {}), { status });
	};
	return { fetch, calls };
}
const mk = (git: ReturnType<typeof fakeGit>, extra: Record<string, unknown> = {}) =>
	createGithubClient({ token: TOKEN, target: TARGET, fetch: git.fetch, ...extra });

const BIN = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 0x80, 0x7f]);
const text = (s: string): FileChange => ({ path: 'src/data/models.json', text: s });

// ---- request sequence -----------------------------------------------------------------------------------

test('commitFiles: exact request sequence, URLs, methods and bodies', async () => {
	const git = fakeGit();
	const result = await mk(git).commitFiles({
		message: 'admin: update model library (+1)',
		changes: [{ path: 'public/models/chair.glb', bytes: BIN }, text('[]\n')],
	});
	assert.deepEqual(result, { commitSha: 'new-commit-sha' });
	assert.deepEqual(
		git.calls.map((c) => `${c.method} ${c.url.replace(REPO, '')}`),
		[
			`GET /git/ref/heads/${BRANCH}`,
			'GET /git/commits/head-sha',
			'POST /git/blobs',
			'POST /git/blobs',
			'POST /git/trees',
			'POST /git/commits',
			`PATCH /git/refs/heads/${BRANCH}`,
		],
	);
	const [, , blob1, blob2, tree, commit, patch] = git.calls;
	assert.deepEqual(blob1.body, { content: Buffer.from(BIN).toString('base64'), encoding: 'base64' });
	assert.deepEqual(blob2.body, { content: Buffer.from('[]\n').toString('base64'), encoding: 'base64' });
	assert.deepEqual(tree.body, {
		base_tree: 'base-tree-sha',
		tree: [
			{ path: 'public/models/chair.glb', mode: '100644', type: 'blob', sha: 'blob-1' },
			{ path: 'src/data/models.json', mode: '100644', type: 'blob', sha: 'blob-2' },
		],
	});
	assert.deepEqual(commit.body, { message: 'admin: update model library (+1)', tree: 'new-tree-sha', parents: ['head-sha'] });
	assert.deepEqual(patch.body, { sha: 'new-commit-sha', force: false }, 'ref update is never forced');
});

test('commitFiles: every request carries the token, API version and JSON content type on writes; the token never appears in a body or URL', async () => {
	const git = fakeGit();
	await mk(git).commitFiles({ message: 'm', changes: [text('x')] });
	for (const c of git.calls) {
		assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
		assert.equal(c.headers['X-GitHub-Api-Version'], '2022-11-28');
		assert.ok(!c.url.includes(TOKEN));
		assert.ok(!JSON.stringify(c.body ?? {}).includes(TOKEN));
		if (c.method !== 'GET') assert.equal(c.headers['Content-Type'], 'application/json');
	}
	assert.ok(git.calls.every((c) => c.url.startsWith(`${API_BASE}/`)), 'only api.github.com URLs');
});

test('commitFiles: only the github host is ever contacted, over https', async () => {
	const git = fakeGit();
	await mk(git).commitFiles({ message: 'm', changes: [{ path: 'a/b.glb', bytes: BIN }, { path: 'c.json', delete: true }] });
	for (const c of git.calls) assert.equal(new URL(c.url).origin, 'https://api.github.com');
});

test('commitFiles: bytes are base64 exactly (all 256 byte values, empty, large 3 MB)', async () => {
	const all = Uint8Array.from({ length: 256 }, (_, i) => i);
	const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31 + 7) & 255);
	for (const bytes of [all, new Uint8Array(0), big]) {
		const git = fakeGit();
		await mk(git).commitFiles({ message: 'm', changes: [{ path: 'public/models/x.glb', bytes }] });
		assert.equal(git.calls.find((c) => c.url.endsWith('/git/blobs'))!.body.content, Buffer.from(bytes).toString('base64'));
	}
	assert.equal(encodeBase64Bytes(big), Buffer.from(big).toString('base64'));
});

test('commitFiles: text changes are UTF-8 encoded (tabs, newline, non-Latin, emoji)', async () => {
	const content = '[\n\t{ "label": "Əlişli 🪑 日本語" }\n]\n';
	const git = fakeGit();
	await mk(git).commitFiles({ message: 'm', changes: [text(content)] });
	assert.equal(Buffer.from(git.calls.find((c) => c.url.endsWith('/git/blobs'))!.body.content, 'base64').toString('utf8'), content);
});

test('commitFiles: deletions go into the tree as sha: null and need no blob', async () => {
	const git = fakeGit();
	await mk(git).commitFiles({ message: 'm', changes: [{ path: 'public/models/old.glb', delete: true }, text('[]\n')] });
	assert.equal(git.calls.filter((c) => c.url.endsWith('/git/blobs')).length, 1, 'one blob (models.json) only');
	const tree = git.calls.find((c) => c.url.endsWith('/git/trees'))!.body.tree;
	assert.deepEqual(tree[0], { path: 'public/models/old.glb', mode: '100644', type: 'blob', sha: null });
	assert.equal(tree[1].path, 'src/data/models.json');
	assert.ok(typeof tree[1].sha === 'string');
});

test('commitFiles: a delete-only commit makes no blob requests', async () => {
	const git = fakeGit();
	await mk(git).commitFiles({ message: 'm', changes: [{ path: 'public/models/old.glb', delete: true }] });
	assert.equal(git.calls.filter((c) => c.url.endsWith('/git/blobs')).length, 0);
});

test('commitFiles: tree order follows the change order', async () => {
	const git = fakeGit();
	await mk(git).commitFiles({
		message: 'm',
		changes: [{ path: 'public/models/b.glb', bytes: BIN }, { path: 'public/models/a.glb', delete: true }, text('t')],
	});
	assert.deepEqual(git.calls.find((c) => c.url.endsWith('/git/trees'))!.body.tree.map((t: { path: string }) => t.path), ['public/models/b.glb', 'public/models/a.glb', 'src/data/models.json']);
});

test('commitFiles: a branch name with a slash keeps its slash in ref URLs', async () => {
	const target = { ...TARGET, branch: 'feature/models' };
	const calls: string[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		calls.push(`${init?.method ?? 'GET'} ${url}`);
		const body = url.includes('/git/ref/') ? { object: { sha: 'h' } } : url.includes('/git/commits/') ? { tree: { sha: 't' } } : { sha: 'x' };
		return new Response(JSON.stringify(body), { status: 200 });
	};
	await createGithubClient({ token: TOKEN, target, fetch }).commitFiles({ message: 'm', changes: [{ path: 'a.txt', delete: true }] });
	assert.ok(calls[0].endsWith('/git/ref/heads/feature/models'), calls[0]);
	assert.ok(calls.at(-1)!.endsWith('/git/refs/heads/feature/models'), calls.at(-1));
});

test('gitUrl builds the expected endpoints', () => {
	assert.equal(gitUrl(TARGET, 'blobs'), `${REPO}/git/blobs`);
	assert.equal(gitUrl(TARGET, 'trees'), `${REPO}/git/trees`);
	assert.equal(gitUrl(TARGET, 'commits'), `${REPO}/git/commits`);
	assert.equal(gitUrl(TARGET, 'commits', 'abc'), `${REPO}/git/commits/abc`);
	assert.equal(gitUrl(TARGET, 'ref', 'heads/main'), `${REPO}/git/ref/heads/main`);
	assert.equal(gitUrl(TARGET, 'refs', 'heads/main'), `${REPO}/git/refs/heads/main`);
});

// ---- expectedHead / conflicts ----------------------------------------------------------------------------

test('commitFiles: expectedHead that still matches proceeds', async () => {
	const git = fakeGit({ head: 'H1' });
	await mk(git).commitFiles({ message: 'm', changes: [text('x')], expectedHead: 'H1' });
	assert.equal(git.calls.at(-1)!.method, 'PATCH');
});

test('commitFiles: expectedHead mismatch -> conflict BEFORE anything is written', async () => {
	const git = fakeGit({ head: 'H2' });
	await assert.rejects(
		() => mk(git).commitFiles({ message: 'm', changes: [text('x')], expectedHead: 'H1' }),
		(e: unknown) => e instanceof GithubError && e.kind === 'conflict',
	);
	assert.deepEqual(git.calls.map((c) => c.method), ['GET'], 'only the ref was read; no blob, tree, commit or PATCH');
});

test('commitFiles: 422 "Update is not a fast forward" on the ref PATCH -> conflict', async () => {
	const git = fakeGit({
		override: (c) => (c.method === 'PATCH' ? { status: 422, body: { message: 'Update is not a fast forward' } } : undefined),
	});
	await assert.rejects(
		() => mk(git).commitFiles({ message: 'm', changes: [text('x')] }),
		(e: unknown) => e instanceof GithubError && e.kind === 'conflict' && e.status === 422 && /branch changed/i.test(e.message),
	);
});

test('mapHttpError: not-a-fast-forward variants map to conflict, other 422s stay rejected, existing mappings unchanged', () => {
	assert.equal(mapHttpError(422, { message: 'Update is not a fast forward' }).kind, 'conflict');
	assert.equal(mapHttpError(422, { message: 'Reference update failed' }).kind, 'rejected', 'a failed ref update is not necessarily a lost race: no retry');
	assert.equal(mapHttpError(422, { message: 'update is not a FAST-FORWARD' }).kind, 'conflict');
	assert.equal(mapHttpError(422, { message: 'Invalid tree info' }).kind, 'rejected');
	assert.equal(mapHttpError(422, { message: 'Protected branch update failed' }).kind, 'rejected');
	assert.equal(mapHttpError(422, { message: 'tree.sha wasn\'t supplied' }).kind, 'conflict', 'the old sha rule still applies');
	assert.equal(mapHttpError(422, null).kind, 'conflict', 'no message: old behaviour');
	assert.equal(mapHttpError(409, {}).kind, 'conflict');
	assert.equal(mapHttpError(401, {}).kind, 'auth');
	assert.equal(mapHttpError(403, {}).kind, 'auth');
	assert.equal(mapHttpError(404, {}).kind, 'not-found');
	assert.equal(mapHttpError(500, {}).kind, 'server');
	assert.equal(mapHttpError(429, { message: 'API rate limit exceeded' }).kind, 'rate-limit');
});

// ---- failures at each step ------------------------------------------------------------------------------

for (const [step, match, kind, status] of [
	['GET ref', (c: Call) => c.method === 'GET' && c.url.includes('/git/ref/'), 'not-found', 404],
	['GET commit', (c: Call) => c.method === 'GET' && c.url.includes('/git/commits/'), 'server', 502],
	['POST blob', (c: Call) => c.url.endsWith('/git/blobs'), 'auth', 403],
	['POST tree', (c: Call) => c.url.endsWith('/git/trees'), 'rejected', 422],
	['POST commit', (c: Call) => c.method === 'POST' && c.url.endsWith('/git/commits'), 'server', 500],
	['PATCH ref', (c: Call) => c.method === 'PATCH', 'auth', 401],
] as const) {
	test(`commitFiles: failure at "${step}" maps to ${kind} and stops the sequence there`, async () => {
		const git = fakeGit({ override: (c) => (match(c) ? { status, body: { message: 'Invalid tree info' } } : undefined) });
		await assert.rejects(
			() => mk(git).commitFiles({ message: 'm', changes: [text('x')] }),
			(e: unknown) => e instanceof GithubError && e.kind === kind && e.status === status,
		);
		const failedAt = git.calls.findIndex(match);
		assert.equal(git.calls.length, failedAt + 1, 'nothing is sent after the failing request');
		if (step !== 'PATCH ref') assert.ok(!git.calls.some((c) => c.method === 'PATCH'), 'ref is never moved before the commit exists');
	});
}

test('commitFiles: a rate-limited 403 and a network failure keep their kinds', async () => {
	const limited = fakeGit({ override: () => ({ status: 403, body: { message: 'API rate limit exceeded for user' } }) });
	await assert.rejects(() => mk(limited).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'rate-limit');
	const down = fakeGit({ override: () => ({ reject: new TypeError('Failed to fetch') }) });
	await assert.rejects(() => mk(down).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'network');
});

test('commitFiles: a response without a sha is bad-response (blob, tree, commit, ref head, head commit tree)', async () => {
	for (const [match, body] of [
		[(c: Call) => c.url.endsWith('/git/blobs'), {}],
		[(c: Call) => c.url.endsWith('/git/trees'), { sha: 5 }],
		[(c: Call) => c.method === 'POST' && c.url.endsWith('/git/commits'), { sha: '' }],
		[(c: Call) => c.url.includes('/git/ref/'), { object: {} }],
		[(c: Call) => c.method === 'GET' && c.url.includes('/git/commits/'), { tree: {} }],
	] as const) {
		const git = fakeGit({ override: (c) => (match(c) ? { status: 200, body } : undefined) });
		await assert.rejects(() => mk(git).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'bad-response');
	}
});

test('commitFiles: error messages never contain the token or response bodies verbatim beyond GitHub\'s message', async () => {
	const git = fakeGit({ override: (c) => (c.method === 'PATCH' ? { status: 500, body: { message: 'boom', documentation_url: 'https://x' } } : undefined) });
	await assert.rejects(() => mk(git).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && !e.message.includes(TOKEN) && !e.message.includes('documentation_url'));
});

// ---- argument validation (nothing is sent) ---------------------------------------------------------------

test('commitFiles: empty change list, duplicate paths and bad paths are invalid-config with zero requests', async () => {
	const cases: FileChange[][] = [
		[],
		[text('a'), text('b')],
		[{ path: '/abs.txt', text: 'x' }],
		[{ path: '../escape.txt', text: 'x' }],
		[{ path: 'a//b.txt', text: 'x' }],
		[{ path: 'a\\b.txt', text: 'x' }],
		[{ path: 'dir/', text: 'x' }],
		[{ path: '', text: 'x' }],
		[{ path: 'a/./b.txt', delete: true }],
	];
	for (const changes of cases) {
		const git = fakeGit();
		await assert.rejects(() => mk(git).commitFiles({ message: 'm', changes }), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config', JSON.stringify(changes.map((c) => c.path)));
		assert.equal(git.calls.length, 0);
	}
});

test('commitFiles / getHead / getFileAt: preflight errors (no token, bad target) before any request', async () => {
	const git = fakeGit();
	const noToken = createGithubClient({ token: '', target: TARGET, fetch: git.fetch });
	await assert.rejects(() => noToken.commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config');
	await assert.rejects(() => noToken.getHead(), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config');
	await assert.rejects(() => noToken.getFileAt('a.json', 'sha'), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config');
	const spaced = createGithubClient({ token: 'tok en', target: TARGET, fetch: git.fetch });
	await assert.rejects(() => spaced.getHead(), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config');
	const badBranch = createGithubClient({ token: TOKEN, target: { ...TARGET, branch: 'a..b' }, fetch: git.fetch });
	await assert.rejects(() => badBranch.commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config');
	assert.equal(git.calls.length, 0);
});

// ---- getHead / getFileAt ---------------------------------------------------------------------------------

test('getHead returns the sha at the branch tip via GET git/ref/heads/<branch>', async () => {
	const git = fakeGit({ head: 'abc123' });
	assert.equal(await mk(git).getHead(), 'abc123');
	assert.equal(git.calls[0].url, `${REPO}/git/ref/heads/${BRANCH}`);
	assert.equal(git.calls[0].method, 'GET');
});

test('getFileAt reads a path at a commit: URL has ?ref=<sha>, text decoded (incl. wrapped base64)', async () => {
	const content = '[{"id":"é"}]\n';
	const b64 = Buffer.from(content).toString('base64').replace(/(.{8})/g, '$1\n');
	const git = fakeGit({ override: () => ({ body: { type: 'file', encoding: 'base64', sha: 'blob-sha', content: b64 } }) });
	const file = await mk(git).getFileAt('src/data/models.json', 'commit-sha-1');
	assert.deepEqual(file, { text: content, sha: 'blob-sha' });
	assert.equal(git.calls[0].url, `${REPO}/contents/src/data/models.json?ref=commit-sha-1`);
	assert.equal(git.calls[0].method, 'GET');
});

test('getFileAt: directory listing, non-base64 and invalid paths are rejected', async () => {
	const dir = fakeGit({ override: () => ({ body: [{ name: 'a' }] }) });
	await assert.rejects(() => mk(dir).getFileAt('src/data', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'bad-response');
	const big = fakeGit({ override: () => ({ body: { type: 'file', encoding: 'none', sha: 's', content: '' } }) });
	await assert.rejects(() => mk(big).getFileAt('x.json', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'bad-response');
	const g = fakeGit();
	await assert.rejects(() => mk(g).getFileAt('../x', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config');
	assert.equal(g.calls.length, 0);
});

test('getFileAt: 404 -> not-found, ref is URL-encoded', async () => {
	const git = fakeGit({ override: () => ({ status: 404, body: { message: 'Not Found' } }) });
	await assert.rejects(() => mk(git).getFileAt('a.json', 'we ird/ref'), (e: unknown) => e instanceof GithubError && e.kind === 'not-found');
	assert.ok(git.calls[0].url.endsWith('?ref=we%20ird%2Fref'), git.calls[0].url);
});

// ---- timeouts --------------------------------------------------------------------------------------------

test('uploadTimeoutMs applies to blob uploads only (default is longer than the normal timeout)', async () => {
	// A blob POST that never answers is aborted by the UPLOAD timeout; with a tiny normal timeout the earlier GETs still work.
	const hang = (c: Call) => (c.url.endsWith('/git/blobs') ? new Promise<never>(() => {}) : null);
	let aborted = false;
	const fetch = async (url: string, init?: RequestInit) => {
		const call: Call = { url, method: init?.method ?? 'GET', body: undefined, headers: {}, signal: init?.signal ?? undefined };
		if (hang(call)) {
			return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }));
		}
		const body = url.includes('/git/ref/') ? { object: { sha: 'h' } } : { tree: { sha: 't' } };
		return new Response(JSON.stringify(body), { status: 200 });
	};
	const started = Date.now();
	const gh = createGithubClient({ token: TOKEN, target: TARGET, fetch, timeoutMs: 20, uploadTimeoutMs: 150 });
	await assert.rejects(() => gh.commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'timeout');
	const elapsed = Date.now() - started;
	assert.ok(aborted);
	assert.ok(elapsed >= 140, `waited for the upload timeout (${elapsed} ms), not the 20 ms normal one`);
});

test('a non-blob request still uses the normal timeout', async () => {
	const fetch = (_url: string, init?: RequestInit) =>
		new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
	const gh = createGithubClient({ token: TOKEN, target: TARGET, fetch, timeoutMs: 30, uploadTimeoutMs: 5000 });
	const t = Date.now();
	await assert.rejects(() => gh.getHead(), (e: unknown) => e instanceof GithubError && e.kind === 'timeout');
	assert.ok(Date.now() - t < 1000);
});

test('the fetch used is looked up at call time when none is injected (window.fetch override works)', async () => {
	const original = globalThis.fetch;
	const git = fakeGit();
	globalThis.fetch = git.fetch as unknown as typeof fetch;
	try {
		const gh = createGithubClient({ token: TOKEN, target: TARGET }); // created BEFORE the override takes effect for later calls
		globalThis.fetch = ((url: string, init?: RequestInit) => git.fetch(url, init)) as unknown as typeof fetch;
		assert.equal(await gh.getHead(), 'head-sha');
		assert.equal(git.calls.length, 1);
	} finally {
		globalThis.fetch = original;
	}
});

// ---- existing single-file flow untouched -----------------------------------------------------------------

test('putFile still uses the Contents API (PUT, branch in body) and getFile its GET URL', async () => {
	const calls: Call[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined, headers: {} });
		if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ type: 'file', encoding: 'base64', sha: 's1', content: Buffer.from('{}').toString('base64') }), { status: 200 });
		return new Response(JSON.stringify({ content: { sha: 's2' }, commit: { sha: 'c2' } }), { status: 200 });
	};
	const gh = createGithubClient({ token: TOKEN, target: TARGET, fetch });
	await gh.getFile();
	const put = await gh.putFile({ text: '{}', message: 'm', sha: 's1' });
	assert.equal(calls[0].url, `${REPO}/contents/${TARGET.path}?ref=${BRANCH}`);
	assert.equal(calls[1].method, 'PUT');
	assert.equal(calls[1].url, `${REPO}/contents/${TARGET.path}`);
	assert.deepEqual(calls[1].body, { message: 'm', content: Buffer.from('{}').toString('base64'), branch: BRANCH, sha: 's1' });
	assert.deepEqual(put, { sha: 's2', commitSha: 'c2' });
});

// ---- m5: Git Data errors are mapped on their own; scene (Contents API) mapping is unchanged ------------------

test('mapHttpError (m5): in git mode only the fast-forward 422 is a conflict; other 409/422 are rejected', () => {
	const git = { git: true };
	assert.equal(mapHttpError(422, { message: 'Update is not a fast forward' }, null, git).kind, 'conflict');
	assert.equal(mapHttpError(422, { message: 'Reference update failed' }, null, git).kind, 'rejected', 'only the fast-forward wording is a conflict');
	for (const [status, message] of [
		[409, 'Git Repository is empty.'],
		[422, 'tree.sha wasn\'t supplied'],
		[422, 'GitRPC::BadObjectState: sha mismatch'],
		[422, 'Invalid tree info'],
		[409, ''],
	] as const) {
		const e = mapHttpError(status, { message }, null, git);
		assert.equal(e.kind, 'rejected', `${status} ${message}`);
		assert.match(e.message, /library/i, 'the message talks about the library save');
		assert.doesNotMatch(e.message, /file changed on GitHub since it was loaded/i);
	}
	assert.equal(mapHttpError(422, null, null, git).kind, 'rejected', 'a bodiless 422 in git mode is not a retryable conflict');
});

test('mapHttpError (m5): git mode leaves every other status as before', () => {
	const git = { git: true };
	assert.equal(mapHttpError(401, {}, null, git).kind, 'auth');
	assert.equal(mapHttpError(403, {}, null, git).kind, 'auth');
	assert.equal(mapHttpError(404, {}, null, git).kind, 'not-found');
	assert.equal(mapHttpError(500, {}, null, git).kind, 'server');
	assert.equal(mapHttpError(429, { message: 'API rate limit exceeded' }, null, git).kind, 'rate-limit');
	assert.equal(mapHttpError(418, {}, null, git).kind, 'unknown');
});

test('mapHttpError (m5): WITHOUT git mode (scene save, getFileAt) the old sha/409 -> conflict mapping is unchanged', () => {
	assert.equal(mapHttpError(409, {}).kind, 'conflict');
	assert.equal(mapHttpError(422, null).kind, 'conflict');
	assert.equal(mapHttpError(422, { message: 'sha wasn\'t supplied' }).kind, 'conflict');
	assert.equal(mapHttpError(422, { message: 'Invalid request' }).kind, 'rejected');
	assert.equal(mapHttpError(422, { message: 'Update is not a fast forward' }).kind, 'conflict');
});

test('mapHttpError (m7): the missing-file hint appears only for a commit that deletes files', () => {
	const withDeletes = mapHttpError(422, { message: 'Invalid tree info' }, null, { git: true, deletes: true });
	assert.equal(withDeletes.kind, 'rejected');
	assert.match(withDeletes.message, /already missing from the repository/i);
	assert.match(withDeletes.message, /src\/data\/models\.json/);
	for (const opts of [{ git: true }, { git: true, deletes: false }]) {
		const e = mapHttpError(422, { message: 'Invalid tree info' }, null, opts);
		assert.doesNotMatch(e.message, /by hand|already missing/i);
		assert.match(e.message, /GitHub refused the library save/i);
		assert.match(e.message, /Invalid tree info/, "GitHub's own message is kept");
	}
});

// ---- hint scoping: the hint is added by the tree POST of a commit that deletes, and by nothing else -----------------

test('commitFiles (hint scoping): a 422 on the TREE of a commit WITH deletions carries the by-hand hint', async () => {
	const git = fakeGit({ override: (c) => (c.url.endsWith('/git/trees') ? { status: 422, body: { message: 'Invalid tree info' } } : undefined) });
	await assert.rejects(
		() => mk(git).commitFiles({ message: 'm', changes: [{ path: 'public/models/gone.glb', delete: true }, text('x')] }),
		(e: unknown) => e instanceof GithubError && e.kind === 'rejected' && /by hand/i.test(e.message),
	);
});

test('commitFiles (hint scoping): the same 422 on a commit WITHOUT deletions has no hint', async () => {
	const git = fakeGit({ override: (c) => (c.url.endsWith('/git/trees') ? { status: 422, body: { message: 'Invalid tree info' } } : undefined) });
	await assert.rejects(
		() => mk(git).commitFiles({ message: 'm', changes: [{ path: 'public/models/new.glb', bytes: BIN }, text('x')] }),
		(e: unknown) => e instanceof GithubError && e.kind === 'rejected' && !/by hand/i.test(e.message),
	);
});

test('commitFiles (hint scoping): a delete commit whose OTHER steps fail (blob, commit POST, ref PATCH) gets no hint', async () => {
	for (const match of [
		(c: Call) => c.url.endsWith('/git/blobs'),
		(c: Call) => c.method === 'POST' && c.url.endsWith('/git/commits'),
		(c: Call) => c.method === 'PATCH',
	]) {
		const git = fakeGit({ override: (c) => (match(c) ? { status: 422, body: { message: 'Validation Failed' } } : undefined) });
		await assert.rejects(
			() => mk(git).commitFiles({ message: 'm', changes: [{ path: 'public/models/gone.glb', delete: true }, text('x')] }),
			(e: unknown) => e instanceof GithubError && e.kind === 'rejected' && !/by hand/i.test(e.message),
		);
	}
});

test('commitFiles (m-r2-1): a ref PATCH 422 "Reference update failed" is rejected (no retry), the fast-forward wording stays a conflict', async () => {
	const failed = fakeGit({ override: (c) => (c.method === 'PATCH' ? { status: 422, body: { message: 'Reference update failed' } } : undefined) });
	await assert.rejects(() => mk(failed).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'rejected');
	const ff = fakeGit({ override: (c) => (c.method === 'PATCH' ? { status: 422, body: { message: 'Update is not a fast forward' } } : undefined) });
	await assert.rejects(() => mk(ff).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'conflict');
});

// ---- getBlobSha ---------------------------------------------------------------------------------------------------

test('getBlobSha: one contents GET at ?ref=<sha>, returns the blob sha', async () => {
	const git = fakeGit({ override: () => ({ body: { type: 'file', encoding: 'base64', sha: 'abc123blob', content: 'AAAA' } }) });
	assert.equal(await mk(git).getBlobSha('public/models/chair.glb', 'head-1'), 'abc123blob');
	assert.equal(git.calls.length, 1);
	assert.equal(git.calls[0].method, 'GET');
	assert.equal(git.calls[0].url, `${REPO}/contents/public/models/chair.glb?ref=head-1`);
});

test('getBlobSha: a large file (encoding "none", empty content) still returns its sha', async () => {
	const git = fakeGit({ override: () => ({ body: { type: 'file', encoding: 'none', sha: 'bigsha', size: 5_000_000, content: '' } }) });
	assert.equal(await mk(git).getBlobSha('public/models/big.glb', 'h'), 'bigsha');
});

test('getBlobSha: 404 -> null; other errors propagate with their kind', async () => {
	const nf = fakeGit({ override: () => ({ status: 404, body: { message: 'Not Found' } }) });
	assert.equal(await mk(nf).getBlobSha('public/models/missing.glb', 'h'), null);
	for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [500, 'server'], [429, 'rate-limit']] as const) {
		const g = fakeGit({ override: () => ({ status, body: { message: status === 429 ? 'API rate limit exceeded' : 'x' } }) });
		await assert.rejects(() => mk(g).getBlobSha('a/b.glb', 'h'), (e: unknown) => e instanceof GithubError && e.kind === kind, `${status}`);
	}
	const net = fakeGit({ override: () => ({ reject: new TypeError('Failed to fetch') }) });
	await assert.rejects(() => mk(net).getBlobSha('a/b.glb', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'network');
});

test('getBlobSha: a directory listing / answer without a sha is bad-response; bad path or no token send nothing', async () => {
	const dir = fakeGit({ override: () => ({ body: [{ name: 'x' }] }) });
	await assert.rejects(() => mk(dir).getBlobSha('public/models', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'bad-response');
	const nosha = fakeGit({ override: () => ({ body: { type: 'file' } }) });
	await assert.rejects(() => mk(nosha).getBlobSha('a.glb', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'bad-response');
	const g = fakeGit();
	await assert.rejects(() => mk(g).getBlobSha('../x', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config');
	await assert.rejects(() => createGithubClient({ token: '', target: TARGET, fetch: g.fetch }).getBlobSha('a.glb', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'invalid-config');
	assert.equal(g.calls.length, 0);
});


test('commitFiles (m5): a 422 with "sha" in the message at the TREE step is rejected, not conflict (so saveModels does not burn its retry)', async () => {
	const git = fakeGit({ override: (c) => (c.url.endsWith('/git/trees') ? { status: 422, body: { message: 'tree.sha is not a valid sha' } } : undefined) });
	await assert.rejects(() => mk(git).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'rejected');
});

test('commitFiles (m5): 409 "Git Repository is empty" on the ref read is rejected; a 409 on the PATCH too', async () => {
	const a = fakeGit({ override: (c) => (c.url.includes('/git/ref/') ? { status: 409, body: { message: 'Git Repository is empty.' } } : undefined) });
	await assert.rejects(() => mk(a).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'rejected');
	const b = fakeGit({ override: (c) => (c.method === 'PATCH' ? { status: 409, body: { message: 'Conflict' } } : undefined) });
	await assert.rejects(() => mk(b).commitFiles({ message: 'm', changes: [text('x')] }), (e: unknown) => e instanceof GithubError && e.kind === 'rejected');
});

test('getHead (m5): uses git mapping too (a 409 is rejected)', async () => {
	const git = fakeGit({ override: () => ({ status: 409, body: { message: 'Git Repository is empty.' } }) });
	await assert.rejects(() => mk(git).getHead(), (e: unknown) => e instanceof GithubError && e.kind === 'rejected');
});

test('getFileAt / getFile keep the Contents mapping: 409 and a sha-less 422 are still conflict', async () => {
	const g1 = fakeGit({ override: () => ({ status: 409, body: { message: 'x' } }) });
	await assert.rejects(() => mk(g1).getFileAt('a.json', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'conflict');
	const g2 = fakeGit({ override: () => ({ status: 422, body: {} }) });
	await assert.rejects(() => mk(g2).getFile(), (e: unknown) => e instanceof GithubError && e.kind === 'conflict');
});

test('putFile keeps the Contents mapping: 422 about the sha is a conflict, other 422 rejected', async () => {
	const calls: number[] = [];
	for (const [message, kind] of [['sha wasn\'t supplied', 'conflict'], ['Invalid request', 'rejected']] as const) {
		const fetch = async () => { calls.push(1); return new Response(JSON.stringify({ message }), { status: 422 }); };
		await assert.rejects(() => createGithubClient({ token: TOKEN, target: TARGET, fetch }).putFile({ text: '{}', message: 'm' }), (e: unknown) => e instanceof GithubError && e.kind === kind);
	}
});

// ---- getBlobSha: object media type (files up to 100 MB) -------------------------------------------------------------------

test('getBlobSha: sends Accept application/vnd.github.object+json and still the API version and bearer token', async () => {
	const git = fakeGit({ override: () => ({ body: { type: 'file', encoding: 'none', sha: 's1', content: '' } }) });
	await mk(git).getBlobSha('public/models/big.glb', 'h');
	const h = git.calls[0].headers;
	assert.equal(h.Accept, 'application/vnd.github.object+json');
	assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
	assert.equal(h.Authorization, `Bearer ${TOKEN}`);
});

test('getBlobSha: the other reads keep the normal Accept header (only getBlobSha changed)', async () => {
	const git = fakeGit({ override: () => ({ body: { type: 'file', encoding: 'base64', sha: 's', content: Buffer.from('x').toString('base64') } }) });
	await mk(git).getFileAt('a.json', 'h');
	await mk(git).getFile();
	for (const c of git.calls) assert.equal(c.headers.Accept, 'application/vnd.github+json');
	const refs = fakeGit();
	await mk(refs).getHead();
	assert.equal(refs.calls[0].headers.Accept, 'application/vnd.github+json');
});

test('getBlobSha: returns the sha when content is "" and encoding is "none" (a file over 1 MB), and for normal base64 files', async () => {
	for (const body of [
		{ type: 'file', encoding: 'none', sha: 'big-sha', size: 9_000_000, content: '' },
		{ type: 'file', sha: 'no-encoding-sha', size: 9_000_000, content: '' },
		{ type: 'file', encoding: 'base64', sha: 'small-sha', content: 'AAAA' },
	]) {
		const git = fakeGit({ override: () => ({ body }) });
		assert.equal(await mk(git).getBlobSha('public/models/x.glb', 'h'), body.sha);
	}
});

test('getBlobSha: a directory answer (type "dir"), an array, null or a symlink/submodule is bad-response, never a sha', async () => {
	for (const body of [
		{ type: 'dir', sha: 'tree-sha-of-the-directory', entries: [] },
		[{ name: 'a', type: 'file', sha: 'x' }],
		{ type: 'symlink', sha: 's' },
		{ type: 'submodule', sha: 's' },
		{ sha: 'no-type-at-all' },
		null,
	]) {
		const git = fakeGit({ override: () => ({ body }) });
		await assert.rejects(() => mk(git).getBlobSha('public/models', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'bad-response' && /not a file/i.test(e.message), JSON.stringify(body));
	}
});

test('getBlobSha: a file answer without a usable sha is bad-response; 404 is still null', async () => {
	for (const body of [{ type: 'file' }, { type: 'file', sha: '' }, { type: 'file', sha: 7 }]) {
		const git = fakeGit({ override: () => ({ body }) });
		await assert.rejects(() => mk(git).getBlobSha('a.glb', 'h'), (e: unknown) => e instanceof GithubError && e.kind === 'bad-response');
	}
	const nf = fakeGit({ override: () => ({ status: 404, body: { message: 'Not Found' } }) });
	assert.equal(await mk(nf).getBlobSha('a.glb', 'h'), null);
});
