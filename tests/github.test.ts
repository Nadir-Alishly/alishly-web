// Unit tests for src/scripts/admin/github.ts with an injected mock fetch. No network. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	encodeBase64Utf8, decodeBase64Utf8, createGithubClient, GithubError, mapHttpError, describeError, validateTarget,
	contentsUrl, DEFAULT_TARGET, loadToken, saveToken, forgetToken, loadTarget, saveTarget, TOKEN_KEY, TARGET_KEY,
} from '../src/scripts/admin/github.ts';

const TOKEN = 'test-token-123';
const TARGET = { ...DEFAULT_TARGET };

interface Call { url: string; init: RequestInit & { headers: Record<string, string> } }
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; reject?: unknown; raw?: string };

function mockFetch(replies: Reply[]) {
	const calls: Call[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		calls.push({ url, init: init as Call['init'] });
		const r = replies[Math.min(calls.length - 1, replies.length - 1)];
		if (r.reject !== undefined) throw r.reject;
		const status = r.status ?? 200;
		const body = r.raw ?? JSON.stringify(r.body ?? {});
		return new Response(status === 204 ? null : body, { status, headers: r.headers });
	};
	return { fetch, calls };
}
const client = (replies: Reply[], extra: Record<string, unknown> = {}) => {
	const m = mockFetch(replies);
	return { ...m, gh: createGithubClient({ token: TOKEN, target: TARGET, fetch: m.fetch, ...extra }) };
};
const fileBody = (text: string, sha = 'sha-1', wrap = false) => {
	let b64 = Buffer.from(text, 'utf8').toString('base64');
	if (wrap) b64 = b64.replace(/(.{60})/g, '$1\n') + '\n';
	return { type: 'file', encoding: 'base64', sha, content: b64 };
};

// ---- base64 --------------------------------------------------------------------------------

test('base64 UTF-8 round trip: ASCII, Latin-1, non-Latin, emoji, empty', () => {
	const samples = ['', 'hello', '{"a":1}\n', 'Éléonore – café', 'Əlişli ailəsi — Bakı', 'Привет, мир', '日本語のテキスト', 'עברית', '😀👨‍👩‍👧 \u{1F9E0}', 'a\u0000b', 'mixed ✓ ünï 世界 🚀'];
	for (const s of samples) {
		const enc = encodeBase64Utf8(s);
		assert.equal(enc, Buffer.from(s, 'utf8').toString('base64'), `matches Node's own encoder for ${JSON.stringify(s)}`);
		assert.equal(decodeBase64Utf8(enc), s);
	}
});

test('base64: large input (chunking) round-trips', () => {
	const big = 'é世🚀abc'.repeat(50000);
	assert.equal(decodeBase64Utf8(encodeBase64Utf8(big)), big);
});

test('base64: decoding GitHub-style newline-wrapped base64 (and CRLF / spaces)', () => {
	const text = JSON.stringify({ name: 'Əlişli 🚀', rooms: Array.from({ length: 30 }, (_, i) => `room-${i}`) }, null, 2) + '\n';
	const wrapped = Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n') + '\n';
	assert.ok(wrapped.includes('\n'));
	assert.equal(decodeBase64Utf8(wrapped), text);
	assert.equal(decodeBase64Utf8(wrapped.replace(/\n/g, '\r\n')), text);
	assert.equal(decodeBase64Utf8(wrapped.replace(/\n/g, ' \n ')), text);
});

test('base64: invalid UTF-8 and invalid base64 throw', () => {
	assert.throws(() => decodeBase64Utf8(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')));
	assert.throws(() => decodeBase64Utf8('***not base64***'));
});

// ---- URL / target -----------------------------------------------------------------------------

test('contentsUrl: GET has ?ref=branch, PUT has none; path segments are encoded', () => {
	assert.equal(contentsUrl(TARGET, true), 'https://api.github.com/repos/Nadir-Alishly/alishly-web/contents/src/data/scene.json?ref=main');
	assert.equal(contentsUrl(TARGET, false), 'https://api.github.com/repos/Nadir-Alishly/alishly-web/contents/src/data/scene.json');
	assert.equal(contentsUrl({ ...TARGET, branch: 'feat/x y', path: 'a b/c#d.json' }, true),
		'https://api.github.com/repos/Nadir-Alishly/alishly-web/contents/a%20b/c%23d.json?ref=feat%2Fx%20y');
});

test('default target matches the plan', () => {
	assert.deepEqual(DEFAULT_TARGET, { owner: 'Nadir-Alishly', repo: 'alishly-web', branch: 'main', path: 'src/data/scene.json' });
});

test('validateTarget accepts the default and rejects traversal / garbage', () => {
	assert.equal(validateTarget(TARGET), null);
	assert.equal(validateTarget({ ...TARGET, branch: 'release/1.0' }), null);
	for (const bad of [
		{ owner: '' }, { owner: 'a b' }, { owner: '-x' }, { owner: 'x/y' }, { owner: 'a'.repeat(40) },
		{ repo: '' }, { repo: '..' }, { repo: 'a/b' }, { repo: 'a b' },
		{ branch: '' }, { branch: 'a b' }, { branch: 'a..b' }, { branch: '/a' }, { branch: 'a/' }, { branch: 'x.lock' }, { branch: 'a:b' }, { branch: 'a?b' },
		{ path: '' }, { path: '/etc/passwd' }, { path: 'a/../b' }, { path: 'a//b' }, { path: 'dir/' }, { path: 'a\\b' }, { path: './x' },
	]) {
		assert.notEqual(validateTarget({ ...TARGET, ...bad }), null, JSON.stringify(bad));
	}
});

// ---- GET ------------------------------------------------------------------------------------------

test('getFile: request shape', async () => {
	const { gh, calls } = client([{ body: fileBody('{}') }]);
	await gh.getFile();
	assert.equal(calls.length, 1);
	const { url, init } = calls[0];
	assert.equal(url, 'https://api.github.com/repos/Nadir-Alishly/alishly-web/contents/src/data/scene.json?ref=main');
	assert.equal(init.method, 'GET');
	assert.equal(init.cache, 'no-store');
	assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
	assert.equal(init.headers.Accept, 'application/vnd.github+json');
	assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
	assert.equal(init.body, undefined);
	assert.ok(!url.includes(TOKEN), 'token not in URL');
	assert.ok(init.signal instanceof AbortSignal, 'has a timeout signal');
});

test('getFile: decodes content (incl. newline-wrapped, non-Latin) and returns sha', async () => {
	const text = JSON.stringify({ version: 1, rooms: { elnur: { objects: [] } }, note: 'Əlişli 🚀' }, null, 2) + '\n';
	const { gh } = client([{ body: fileBody(text, 'abc123', true) }]);
	assert.deepEqual(await gh.getFile(), { text, sha: 'abc123' });
});

test('getFile: bad responses -> bad-response', async () => {
	for (const body of [null, [], { type: 'dir', sha: 's', encoding: 'base64', content: '' }, { type: 'file', encoding: 'base64', content: 'e30=' },
		{ type: 'file', sha: 's', encoding: 'none', content: 'e30=' }, { type: 'file', sha: 's', encoding: 'base64' }, { type: 'file', sha: 5, encoding: 'base64', content: 'e30=' },
		{ type: 'file', sha: 's', encoding: 'base64', content: Buffer.from([0xff, 0xfe]).toString('base64') }]) {
		const { gh } = client([{ body }]);
		await assert.rejects(gh.getFile(), (e: GithubError) => e instanceof GithubError && e.kind === 'bad-response', JSON.stringify(body));
	}
	const { gh } = client([{ raw: '<html>not json</html>' }]);
	await assert.rejects(gh.getFile(), (e: GithubError) => e.kind === 'bad-response');
});

// ---- PUT ------------------------------------------------------------------------------------------

test('putFile: request shape and body', async () => {
	const text = JSON.stringify({ version: 1, rooms: {}, label: 'Əlişli 🚀' }, null, 2) + '\n';
	const { gh, calls } = client([{ body: { content: { sha: 'sha-2' }, commit: { sha: 'c-1' } } }]);
	const res = await gh.putFile({ text, message: 'Update scene', sha: 'sha-1' });
	assert.deepEqual(res, { sha: 'sha-2', commitSha: 'c-1' });
	const { url, init } = calls[0];
	assert.equal(url, 'https://api.github.com/repos/Nadir-Alishly/alishly-web/contents/src/data/scene.json');
	assert.equal(init.method, 'PUT');
	assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
	assert.equal(init.headers['Content-Type'], 'application/json');
	assert.equal(init.headers.Accept, 'application/vnd.github+json');
	assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
	const body = JSON.parse(init.body as string);
	assert.deepEqual(Object.keys(body).sort(), ['branch', 'content', 'message', 'sha']);
	assert.equal(body.message, 'Update scene');
	assert.equal(body.sha, 'sha-1');
	assert.equal(body.branch, 'main');
	assert.equal(Buffer.from(body.content, 'base64').toString('utf8'), text, 'content is UTF-8 base64 of the text');
	assert.ok(!/\s/.test(body.content), 'no newlines in the base64 we send');
	assert.ok(!(init.body as string).includes(TOKEN), 'token not in body');
	assert.ok(!url.includes(TOKEN));
});

test('putFile: custom branch goes into the body; omitted sha is not sent', async () => {
	const m = mockFetch([{ body: { content: { sha: 's' } } }]);
	const gh = createGithubClient({ token: TOKEN, target: { ...TARGET, branch: 'dev' }, fetch: m.fetch });
	const res = await gh.putFile({ text: 'x', message: 'm' });
	assert.equal(res.commitSha, null, 'commit sha is optional');
	const body = JSON.parse(m.calls[0].init.body as string);
	assert.equal(body.branch, 'dev');
	assert.equal('sha' in body, false);
	await gh.putFile({ text: 'x', message: 'm', sha: null });
	assert.equal('sha' in JSON.parse(m.calls[1].init.body as string), false);
});

test('sha chain: GET sha -> PUT uses it -> PUT response sha is used for the next PUT', async () => {
	const { gh, calls } = client([
		{ body: fileBody('{}', 'sha-A') },
		{ body: { content: { sha: 'sha-B' }, commit: { sha: 'c1' } } },
		{ body: { content: { sha: 'sha-C' }, commit: { sha: 'c2' } } },
	]);
	let sha = (await gh.getFile()).sha;
	assert.equal(sha, 'sha-A');
	sha = (await gh.putFile({ text: '1', message: 'm', sha })).sha;
	assert.equal(sha, 'sha-B');
	sha = (await gh.putFile({ text: '2', message: 'm', sha })).sha;
	assert.equal(sha, 'sha-C');
	assert.equal(JSON.parse(calls[1].init.body as string).sha, 'sha-A');
	assert.equal(JSON.parse(calls[2].init.body as string).sha, 'sha-B');
});

test('putFile: response without content.sha -> bad-response', async () => {
	for (const body of [{}, { content: {} }, { content: { sha: 5 } }, null]) {
		const { gh } = client([{ body }]);
		await assert.rejects(gh.putFile({ text: 'x', message: 'm', sha: 's' }), (e: GithubError) => e.kind === 'bad-response', JSON.stringify(body));
	}
});

// ---- error mapping ----------------------------------------------------------------------------

const expectations: [number, string][] = [[401, 'auth'], [403, 'auth'], [404, 'not-found'], [409, 'conflict'], [422, 'rejected'], [500, 'server'], [502, 'server'], [503, 'server'], [418, 'unknown']];
for (const [status, kind] of expectations) {
	for (const op of ['get', 'put'] as const) {
		test(`HTTP ${status} on ${op.toUpperCase()} -> kind "${kind}", status kept, token not in message`, async () => {
			const { gh } = client([{ status, body: { message: 'Bad credentials' } }]);
			const run = () => (op === 'get' ? gh.getFile() : gh.putFile({ text: 'x', message: 'm', sha: 's' }));
			await assert.rejects(run(), (e: GithubError) => {
				assert.ok(e instanceof GithubError);
				assert.equal(e.kind, kind);
				assert.equal(e.status, status);
				assert.ok(e.message.length > 10);
				assert.ok(!e.message.includes(TOKEN) && !String(e.stack).includes(TOKEN) && !JSON.stringify(e).includes(TOKEN));
				return true;
			});
		});
	}
}

test('error messages are human and specific per status', () => {
	assert.match(mapHttpError(401, null).message, /rejected|invalid|expired/i);
	assert.match(mapHttpError(403, null).message, /not allowed|Contents|permission/i);
	assert.match(mapHttpError(404, null).message, /not found/i);
	assert.match(mapHttpError(409, null).message, /changed/i);
	assert.match(mapHttpError(422, null).message, /changed|missing/i);
	assert.notEqual(mapHttpError(401, null).message, mapHttpError(403, null).message);
});

test('422: only an empty message or one mentioning the sha is a conflict; anything else is "rejected" (no Overwrite)', () => {
	for (const body of [null, {}, { message: '' }, { message: '   ' }, { message: "sha wasn't supplied" }, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, { message: 'SHA does not match' }, { message: 'the file sha is stale' }]) {
		const e = mapHttpError(422, body);
		assert.equal(e.kind, 'conflict', JSON.stringify(body));
		assert.equal(e.status, 422);
	}
	for (const message of ['Changes must be made through a pull request', 'Validation Failed', 'Invalid request. content is not valid Base64', 'Repository rule violations found', 'shared secret', 'Shape mismatch']) {
		const e = mapHttpError(422, { message });
		assert.equal(e.kind, 'rejected', message);
		assert.equal(e.status, 422);
		assert.match(e.message, /GitHub refused this save/);
		assert.ok(e.message.includes(message), 'GitHub\'s own explanation is shown');
		assert.doesNotMatch(e.message, /changed on GitHub/i, 'does not claim the file changed');
	}
	assert.equal(mapHttpError(422, { message: 5 }).kind, 'conflict', 'non-string message counts as no message');
});

test('409 is always a conflict, whatever GitHub says', () => {
	for (const body of [null, {}, { message: 'anything at all' }, { message: 'Changes must be made through a pull request' }]) {
		assert.equal(mapHttpError(409, body).kind, 'conflict', JSON.stringify(body));
	}
});

test('422 "rejected" through the client (PUT) keeps status and the GitHub message, token absent', async () => {
	const { gh } = client([{ status: 422, body: { message: 'Changes must be made through a pull request' } }]);
	await assert.rejects(gh.putFile({ text: 'x', message: 'm', sha: 's' }), (e: GithubError) => {
		assert.equal(e.kind, 'rejected'); assert.equal(e.status, 422);
		assert.match(e.message, /pull request/); assert.ok(!e.message.includes(TOKEN));
		return true;
	});
	const c2 = client([{ status: 422, body: { message: "sha wasn't supplied" } }]);
	await assert.rejects(c2.gh.putFile({ text: 'x', message: 'm' }), (e: GithubError) => e.kind === 'conflict');
});

test('403/429 with exhausted rate limit -> rate-limit (by header or message)', () => {
	const h = new Headers({ 'x-ratelimit-remaining': '0' });
	assert.equal(mapHttpError(403, {}, h).kind, 'rate-limit');
	assert.equal(mapHttpError(429, {}, h).kind, 'rate-limit');
	assert.equal(mapHttpError(403, { message: 'API rate limit exceeded' }).kind, 'rate-limit');
	assert.equal(mapHttpError(403, {}, new Headers({ 'x-ratelimit-remaining': '55' })).kind, 'auth');
	assert.equal(mapHttpError(401, {}, h).kind, 'auth', '401 stays auth');
});

test("GitHub's message is appended, shortened, whitespace-collapsed", () => {
	assert.match(mapHttpError(422, { message: 'sha   wasn\'t supplied' }).message, /GitHub said: sha wasn't supplied/);
	assert.ok(mapHttpError(404, { message: 'x'.repeat(5000) }).message.length < 600);
	assert.doesNotMatch(mapHttpError(404, { message: 5 }).message, /GitHub said/);
	assert.doesNotMatch(mapHttpError(404, null).message, /GitHub said/);
});

test('network error: mapped, original error and token not leaked', async () => {
	const secretish = new TypeError(`Failed to fetch https://api.github.com/?access=${TOKEN}`);
	const { gh } = client([{ reject: secretish }]);
	for (const run of [() => gh.getFile(), () => gh.putFile({ text: 'x', message: 'm', sha: 's' })]) {
		await assert.rejects(run(), (e: GithubError) => {
			assert.equal(e.kind, 'network');
			assert.equal(e.status, 0);
			assert.ok(!e.message.includes(TOKEN) && !String(e.stack).includes(TOKEN));
			assert.equal((e as Error & { cause?: unknown }).cause, undefined, 'caught error not attached');
			return true;
		});
	}
});

test('timeout: a hanging request is aborted -> kind "timeout"', async () => {
	const fetch = (_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
		init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
	});
	const gh = createGithubClient({ token: TOKEN, target: TARGET, fetch, timeoutMs: 20 });
	await assert.rejects(gh.getFile(), (e: GithubError) => e.kind === 'timeout');
});

test('non-JSON error body still maps by status', async () => {
	const { gh } = client([{ status: 502, raw: '<html>Bad gateway</html>' }]);
	await assert.rejects(gh.getFile(), (e: GithubError) => e.kind === 'server' && e.status === 502);
});

test('describeError: GithubError message; anything else is generic and leaks nothing', () => {
	assert.equal(describeError(new GithubError('auth', 'nope', 401)), 'nope');
	const out = describeError(new Error(`secret ${TOKEN}`));
	assert.ok(!out.includes(TOKEN));
	assert.equal(describeError('x'), out);
});

test('invalid config is thrown before any fetch (empty / whitespace token, bad target)', async () => {
	for (const token of ['', '   ', 'has space', 'tab\there', 'new\nline', 'ünï']) {
		const m = mockFetch([{ body: fileBody('{}') }]);
		const gh = createGithubClient({ token, target: TARGET, fetch: m.fetch });
		await assert.rejects(gh.getFile(), (e: GithubError) => e.kind === 'invalid-config');
		await assert.rejects(gh.putFile({ text: 'x', message: 'm' }), (e: GithubError) => e.kind === 'invalid-config');
		assert.equal(m.calls.length, 0, `no request for token ${JSON.stringify(token)}`);
	}
	const m = mockFetch([{}]);
	const gh = createGithubClient({ token: TOKEN, target: { ...TARGET, path: '../x' }, fetch: m.fetch });
	await assert.rejects(gh.getFile(), (e: GithubError) => e.kind === 'invalid-config');
	assert.equal(m.calls.length, 0);
});

test('invalid-config messages do not echo the token', async () => {
	const gh = createGithubClient({ token: 'bad token test-token-123', target: TARGET, fetch: mockFetch([{}]).fetch });
	await assert.rejects(gh.getFile(), (e: GithubError) => { assert.ok(!e.message.includes('test-token-123')); return true; });
});

test('default fetch is looked up at call time (page-level mock works)', async () => {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify(fileBody('{}', 's9'))); }) as typeof fetch;
	try {
		const gh = createGithubClient({ token: TOKEN, target: TARGET }); // created BEFORE the mock below is swapped
		globalThis.fetch = (async (url: string) => { calls.push('late:' + String(url)); return new Response(JSON.stringify(fileBody('{}', 's10'))); }) as typeof fetch;
		const r = await gh.getFile();
		assert.equal(r.sha, 's10');
		assert.ok(calls[0].startsWith('late:https://api.github.com/'));
	} finally { globalThis.fetch = original; }
});

// ---- token / settings storage -----------------------------------------------------------------

const memStorage = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };

test('token storage: default sessionStorage, Remember -> localStorage, exactly one place', () => {
	const s = memStorage(), l = memStorage();
	saveToken(TOKEN, false, s, l);
	assert.equal(s.m.get(TOKEN_KEY), TOKEN);
	assert.equal(l.m.size, 0);
	assert.deepEqual(loadToken(s, l), { token: TOKEN, remembered: false });
	saveToken(TOKEN, true, s, l);
	assert.equal(s.m.size, 0, 'moved out of sessionStorage');
	assert.equal(l.m.get(TOKEN_KEY), TOKEN);
	assert.deepEqual(loadToken(s, l), { token: TOKEN, remembered: true });
	saveToken(TOKEN, false, s, l);
	assert.equal(l.m.size, 0, 'moved out of localStorage');
});

test('token storage: forget clears both; empty token stores nothing; missing storage tolerated', () => {
	const s = memStorage(), l = memStorage();
	s.m.set(TOKEN_KEY, 'a'); l.m.set(TOKEN_KEY, 'b');
	forgetToken(s, l);
	assert.equal(s.m.size + l.m.size, 0);
	assert.deepEqual(loadToken(s, l), { token: '', remembered: false });
	saveToken('', true, s, l);
	assert.equal(s.m.size + l.m.size, 0);
	assert.doesNotThrow(() => { saveToken(TOKEN, true, throwing, throwing); forgetToken(throwing, throwing); loadToken(throwing, throwing); loadToken(null, null); saveToken(TOKEN, false, null, null); forgetToken(null, null); });
	assert.deepEqual(loadToken(throwing, throwing), { token: '', remembered: false });
});

test('token storage: session wins over local', () => {
	const s = memStorage(), l = memStorage();
	s.m.set(TOKEN_KEY, 'from-session'); l.m.set(TOKEN_KEY, 'from-local');
	assert.deepEqual(loadToken(s, l), { token: 'from-session', remembered: false });
});

test('target storage: round trip, partial/garbage values fall back to defaults, token never stored there', () => {
	const l = memStorage();
	assert.deepEqual(loadTarget(l), DEFAULT_TARGET);
	saveTarget({ ...TARGET, branch: 'dev' }, l);
	assert.equal(loadTarget(l).branch, 'dev');
	assert.ok(!l.m.get(TARGET_KEY)!.includes(TOKEN));
	l.m.set(TARGET_KEY, '{"owner":"someone","repo":5}');
	assert.deepEqual(loadTarget(l), { ...DEFAULT_TARGET, owner: 'someone' });
	l.m.set(TARGET_KEY, 'not json');
	assert.deepEqual(loadTarget(l), DEFAULT_TARGET);
	l.m.set(TARGET_KEY, 'null');
	assert.deepEqual(loadTarget(l), DEFAULT_TARGET);
	assert.deepEqual(loadTarget(throwing), DEFAULT_TARGET);
	assert.doesNotThrow(() => saveTarget(TARGET, throwing));
	assert.notEqual(loadTarget(l), DEFAULT_TARGET, 'returns a copy');
});
