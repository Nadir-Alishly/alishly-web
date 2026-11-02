// The shipped texture assets in public/textures (read directly, no build needed). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
	OAK_DIFFUSE_URL, OAK_ROUGHNESS_URL, STUCCO_DETAIL_URL, STUCCO_NORMAL_URL, WINDOW_DIFFUSE_URL, WINDOW_ROUGHNESS_URL,
	TEXTURE_PRELOADS,
} from '../src/data/room-textures.ts';

// One row per shipped file: kind, pixel size, and the smallest plausible byte size (a real map is never this small).
// The room maps are 1024² (the window maps are 512², made from the 1k Poly Haven set for the window frame only).
type Kind = 'jpeg' | 'webp';
interface Asset { file: string; kind: Kind; size: number; minBytes: number; channels?: 1 | 3 }
const dir = new URL('../public/textures/', import.meta.url);
const ASSETS: Asset[] = [
	{ file: 'floor/oak-diff.jpg', kind: 'jpeg', size: 1024, minBytes: 50_000, channels: 3 },
	{ file: 'floor/oak-rough.jpg', kind: 'jpeg', size: 1024, minBytes: 50_000 },
	{ file: 'wall/stucco-detail.jpg', kind: 'jpeg', size: 1024, minBytes: 50_000 },
	{ file: 'wall/stucco-normal.webp', kind: 'webp', size: 512, minBytes: 50_000 },
	{ file: 'window/dark-wood-diff.jpg', kind: 'jpeg', size: 512, minBytes: 20_000, channels: 3 },
	{ file: 'window/dark-wood-rough.jpg', kind: 'jpeg', size: 512, minBytes: 20_000, channels: 1 },
];
const SIZE_BY_FILE = Object.fromEntries(ASSETS.map((a) => [a.file, a.size]));

// JPEG: the SOF0/SOF2 segment holds precision, height, width, then the component count.
// WebP lossless (VP8L) holds width-1 / height-1 in 14 bits each; VP8X holds them in 24-bit fields.
const jpegInfo = (b: Buffer): { width: number; height: number; components: number } => {
	for (let i = 2; i < b.length - 9; ) {
		assert.equal(b[i], 0xff);
		const marker = b[i + 1];
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), components: b[i + 9] };
		}
		i += 2 + b.readUInt16BE(i + 2);
	}
	throw new Error('no SOF marker');
};

test('textures: the 6 texture files (4 room, 2 window) exist, are non-trivial and have the right magic bytes', () => {
	for (const { file, kind, minBytes } of ASSETS) {
		const bytes = readFileSync(new URL(file, dir));
		assert.ok(bytes.length > minBytes, `${file} is ${bytes.length} bytes`);
		if (kind === 'jpeg') {
			assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], `${file} starts with a JPEG SOI marker`);
			assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9], `${file} ends with a JPEG EOI marker`);
		} else {
			assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', `${file} RIFF`);
			assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', `${file} WEBP`);
			assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, `${file} RIFF size matches the file`);
		}
	}
});

test('textures: the total is under 1.2 MB, and each file is near its planned size', () => {
	const sizes = Object.fromEntries(ASSETS.map(({ file }) => [file, statSync(new URL(file, dir)).size]));
	const total = Object.values(sizes).reduce((a, b) => a + b, 0);
	assert.ok(total < 1.2 * 1024 * 1024, `total ${total} bytes`);
	// plan: oak-diff ~175 KB, oak-rough ~400 KB, stucco-detail ~165 KB, stucco-normal ~290 KB (generous bounds)
	assert.ok(sizes['floor/oak-diff.jpg'] < 300_000, 'oak-diff');
	assert.ok(sizes['floor/oak-rough.jpg'] < 550_000, 'oak-rough');
	assert.ok(sizes['wall/stucco-detail.jpg'] < 300_000, 'stucco-detail');
	assert.ok(sizes['wall/stucco-normal.webp'] < 450_000, 'stucco-normal');
	// plan: the window maps are 512² and about 47 KB each (expected total ≈1.18 MB); generous bounds
	assert.ok(sizes['window/dark-wood-diff.jpg'] < 90_000, 'window diffuse');
	assert.ok(sizes['window/dark-wood-rough.jpg'] < 90_000, 'window roughness');
});

test('textures: each map has its planned pixel size (room JPEGs 1024², the window JPEGs 512², the normal map 512²)', () => {
	for (const { file, kind, size } of ASSETS) {
		const b = readFileSync(new URL(file, dir));
		if (kind === 'jpeg') assert.deepEqual([jpegInfo(b).width, jpegInfo(b).height], [size, size], file);
		else {
			const fourcc = b.subarray(12, 16).toString('latin1');
			if (fourcc === 'VP8L') {
				const bits = b.readUInt32LE(21);
				assert.deepEqual([(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1], [size, size], `${file} (VP8L, lossless)`);
			} else if (fourcc === 'VP8X') {
				const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
				const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
				assert.deepEqual([w, h], [size, size], `${file} (VP8X)`);
			} else assert.fail(`${file}: unexpected WebP chunk ${fourcc}`);
		}
	}
});

test('textures: the colour maps are 3-channel and the window roughness map is a 1-channel grey map', () => {
	for (const { file, kind, channels } of ASSETS) {
		if (kind !== 'jpeg' || channels === undefined) continue;
		assert.equal(jpegInfo(readFileSync(new URL(file, dir))).components, channels, `${file} channel count`);
	}
});

test('room-textures: the URL constants are the 6 shipped files, each once, site-root absolute', () => {
	const urls = [OAK_DIFFUSE_URL, OAK_ROUGHNESS_URL, STUCCO_DETAIL_URL, STUCCO_NORMAL_URL, WINDOW_DIFFUSE_URL, WINDOW_ROUGHNESS_URL];
	assert.equal(new Set(urls).size, 6, 'no duplicates');
	assert.deepEqual([...urls].sort(), ASSETS.map(({ file }) => `/textures/${file}`).sort(), 'URL list = the files in public/textures');
	for (const u of urls) {
		assert.ok(u.startsWith('/textures/'), u);
		assert.ok(statSync(new URL(`../public${u}`, import.meta.url)).isFile(), `${u} exists under public/`);
	}
	assert.equal(WINDOW_DIFFUSE_URL, '/textures/window/dark-wood-diff.jpg');
	assert.equal(WINDOW_ROUGHNESS_URL, '/textures/window/dark-wood-rough.jpg');
	assert.equal(SIZE_BY_FILE['window/dark-wood-diff.jpg'], 512);
});

test('room-textures: TEXTURE_PRELOADS lists every texture once; only the stucco normal is skipped on touch screens', () => {
	const all = [OAK_DIFFUSE_URL, OAK_ROUGHNESS_URL, STUCCO_DETAIL_URL, STUCCO_NORMAL_URL, WINDOW_DIFFUSE_URL, WINDOW_ROUGHNESS_URL];
	const hrefs = TEXTURE_PRELOADS.map((p) => p.href);
	assert.deepEqual([...hrefs].sort(), [...all].sort());
	assert.equal(new Set(hrefs).size, hrefs.length, 'no duplicates');
	assert.equal(hrefs.length, 6, 'one preload per URL');
	for (const p of TEXTURE_PRELOADS) {
		if (p.href === STUCCO_NORMAL_URL) assert.equal(p.media, 'not all and (pointer: coarse)');
		else assert.equal(p.media, undefined, p.href);
	}
});

test('room-textures: room-core.ts takes its texture URLs from room-textures.ts (no second hard-coded list to drift)', () => {
	const core = readFileSync(new URL('../src/scripts/room-core.ts', import.meta.url), 'utf8');
	assert.ok(!/['"`]\/?textures\//.test(core), 'no hard-coded /textures/ path literal in room-core.ts');
	assert.match(core, /room-textures/);
});
