// Test harness for the dev-only local save: drives the REAL Vite plugin middleware (dev/local-save-plugin.mjs) with
// mock request/response objects (no socket, no listening server) and exposes it as a `fetch` stub, the way a browser
// on http://localhost:4321 would call it. The repo root is a temp dir created by the caller.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import localSavePlugin from '../../dev/local-save-plugin.mjs';

export const PORT = 4321;
export const ORIGIN = `http://localhost:${PORT}`;

export interface Logged { level: 'info' | 'warn' | 'error'; text: string }

export interface Harness {
	/** Browser-like fetch: relative URLs ("/__local-save/ping") are resolved against ORIGIN. */
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	/** Same, but lets the test set the raw request headers exactly (no defaults added). */
	raw: (method: string, url: string, headers: Record<string, string>, body?: Uint8Array | string) => Promise<Response>;
	logs: Logged[];
	plugin: ReturnType<typeof localSavePlugin>;
	/** Resolves once the plugin has loaded its core (so the first request does not race the lazy import). */
	ready: () => Promise<void>;
}

export interface HarnessOptions {
	root: string;
	/** Defaults to the plain loopback dev server. */
	serverConfig?: { host?: string | boolean; allowedHosts?: unknown };
	command?: string;
	/** Mock of Vite's `server.environments` (e.g. { ssr: { runner: { import } } }) for the validators-through-runner path. */
	environments?: unknown;
}

/** Creates the plugin, runs its configureServer with a mock Vite server, and returns the browser-like fetch. */
export async function makeHarness(options: HarnessOptions): Promise<Harness> {
	const logs: Logged[] = [];
	const logger = {
		info: (text: string) => logs.push({ level: 'info', text }),
		warn: (text: string) => logs.push({ level: 'warn', text }),
		error: (text: string) => logs.push({ level: 'error', text }),
	};
	const handlers: Array<(req: unknown, res: unknown, next: () => void) => unknown> = [];
	const server = {
		config: { command: options.command ?? 'serve', root: options.root, logger, server: options.serverConfig ?? {} },
		environments: options.environments,
		middlewares: { use: (fn: (typeof handlers)[number]) => handlers.push(fn) },
	};
	const plugin = localSavePlugin();
	await (plugin as unknown as { configureServer: (s: unknown) => unknown }).configureServer(server);

	const harness: Harness = {
		logs,
		plugin,
		ready: async () => {
			// the first request awaits the plugin's own readiness; a ping is the cheapest way to wait for it
			await harness.raw('GET', '/__local-save/ping', { host: `localhost:${PORT}` });
		},
		raw: (method, url, headers, body) => dispatch(handlers, harness, method, url, headers, body),
		fetch: (url, init = {}) => {
			const method = (init.method ?? 'GET').toUpperCase();
			const headers: Record<string, string> = { host: `localhost:${PORT}`, 'sec-fetch-site': 'same-origin' };
			// Browsers send Origin on every non-GET/HEAD request, and omit it on a same-origin GET.
			if (method !== 'GET' && method !== 'HEAD') headers.origin = ORIGIN;
			for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
			let body: Uint8Array | string | undefined;
			if (init.body instanceof Uint8Array) body = init.body;
			else if (typeof init.body === 'string') {
				body = init.body;
				headers['content-type'] ??= 'text/plain;charset=UTF-8'; // what a browser does for a string body
			}
			const signal = init.signal as AbortSignal | undefined;
			if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
			return dispatch(handlers, harness, method, url, headers, body);
		},
	};
	return harness;
}

function dispatch(
	handlers: Array<(req: unknown, res: unknown, next: () => void) => unknown>,
	harness: Harness,
	method: string,
	url: string,
	headers: Record<string, string>,
	body?: Uint8Array | string,
): Promise<Response> {
	const path = url.startsWith('http') ? url.slice(ORIGIN.length) : url;
	const bytes = body === undefined ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
	const lower: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
	if (body !== undefined && lower['content-length'] === undefined) lower['content-length'] = String(bytes.byteLength);
	// deliver the body in 64 KiB chunks like a socket would
	const chunks: Buffer[] = [];
	for (let i = 0; i < bytes.byteLength; i += 65536) chunks.push(bytes.subarray(i, i + 65536));
	const req = Object.assign(Readable.from(chunks, { objectMode: false }), {
		method,
		url: path,
		headers: lower,
		socket: { localPort: PORT, encrypted: false },
		destroyed: false,
	});
	return new Promise<Response>((resolve, reject) => {
		const res = Object.assign(new EventEmitter(), {
			statusCode: 0,
			headers: {} as Record<string, string | number>,
			writeHead(status: number, h: Record<string, string | number>) {
				res.statusCode = status;
				res.headers = h;
			},
			end(text?: string) {
				const response = new Response(text ?? '', {
					status: res.statusCode,
					headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])),
				});
				resolve(response);
				queueMicrotask(() => res.emit('finish'));
			},
		});
		const next = () => {
			resolve(new Response('NEXT', { status: 599 })); // not handled by the plugin
		};
		Promise.resolve(handlers[0](req, res, next)).catch(reject);
	});
}
