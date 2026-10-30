// The shipped texture assets in public/textures (read directly, no build needed). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
	OAK_DIFFUSE_URL, OAK_ROUGHNESS_URL, STUCCO_DETAIL_URL, STUCCO_NORMAL_URL, TEXTURE_PRELOADS,
} from '../src/data/room-textures.ts';

const dir = new URL('../public/textures/', import.meta.url);
const FILES: [string, 'jpeg' | 'webp'][] = [
	['floor/oak-diff.jpg', 'jpeg'],
	['floor/oak-rough.jpg', 'jpeg'],
	['wall/stucco-detail.jpg', 'jpeg'],
	['wall/stucco-normal.webp', 'webp'],
];

test('textures: the 4 room texture files exist, are non-trivial and have the right magic bytes', () => {
	for (const [f, kind] of FILES) {
		const bytes = readFileSync(new URL(f, dir));
		assert.ok(bytes.length > 50_000, `${f} is ${bytes.length} bytes`);
		if (kind === 'jpeg') {
			assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], `${f} starts with a JPEG SOI marker`);
			assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9], `${f} ends with a JPEG EOI marker`);
		} else {
			assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', `${f} RIFF`);
			assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', `${f} WEBP`);
			assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, `${f} RIFF size matches the file`);
		}
	}
});

test('textures: the total is under 1.2 MB, and each file is near its planned size', () => {
	const sizes = Object.fromEntries(FILES.map(([f]) => [f, statSync(new URL(f, dir)).size]));
	const total = Object.values(sizes).reduce((a, b) => a + b, 0);
	assert.ok(total < 1.2 * 1024 * 1024, `total ${total} bytes`);
	// plan: oak-diff ~175 KB, oak-rough ~400 KB, stucco-detail ~165 KB, stucco-normal ~290 KB (generous bounds)
	assert.ok(sizes['floor/oak-diff.jpg'] < 300_000, 'oak-diff');
	assert.ok(sizes['floor/oak-rough.jpg'] < 550_000, 'oak-rough');
	assert.ok(sizes['wall/stucco-detail.jpg'] < 300_000, 'stucco-detail');
	assert.ok(sizes['wall/stucco-normal.webp'] < 450_000, 'stucco-normal');
});

test('textures: the oak and stucco maps are 1024 square JPEGs and the normal map is 512 square', () => {
	// JPEG: the SOF0/SOF2 segment holds height then width; WebP lossless (VP8L) holds width-1 / height-1 in 14 bits each.
	const jpegSize = (b: Buffer) => {
		for (let i = 2; i < b.length - 9; ) {
			assert.equal(b[i], 0xff);
			const marker = b[i + 1];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
			i += 2 + b.readUInt16BE(i + 2);
		}
		throw new Error('no SOF marker');
	};
	for (const [f, kind] of FILES) {
		const b = readFileSync(new URL(f, dir));
		if (kind === 'jpeg') assert.deepEqual(jpegSize(b), [1024, 1024], f);
		else {
			const fourcc = b.subarray(12, 16).toString('latin1');
			if (fourcc === 'VP8L') {
				const bits = b.readUInt32LE(21);
				assert.deepEqual([(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1], [512, 512], `${f} (VP8L, lossless)`);
			} else if (fourcc === 'VP8X') {
				const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
				const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
				assert.deepEqual([w, h], [512, 512], `${f} (VP8X)`);
			} else assert.fail(`${f}: unexpected WebP chunk ${fourcc}`);
		}
	}
});

test('room-textures: the URL constants are the 4 shipped files, each once, site-root absolute', () => {
	const urls = [OAK_DIFFUSE_URL, OAK_ROUGHNESS_URL, STUCCO_DETAIL_URL, STUCCO_NORMAL_URL];
	assert.equal(new Set(urls).size, 4, 'no duplicates');
	assert.deepEqual([...urls].sort(), FILES.map(([f]) => `/textures/${f}`).sort(), 'URL list = the files in public/textures');
	for (const u of urls) {
		assert.ok(u.startsWith('/textures/'), u);
		assert.ok(statSync(new URL(`../public${u}`, import.meta.url)).isFile(), `${u} exists under public/`);
	}
});

test('room-textures: TEXTURE_PRELOADS lists every texture once; only the stucco normal is skipped on touch screens', () => {
	const hrefs = TEXTURE_PRELOADS.map((p) => p.href);
	assert.deepEqual([...hrefs].sort(), [OAK_DIFFUSE_URL, OAK_ROUGHNESS_URL, STUCCO_DETAIL_URL, STUCCO_NORMAL_URL].sort());
	assert.equal(new Set(hrefs).size, hrefs.length, 'no duplicates');
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
