// Unit tests for src/scripts/admin/model-file.ts (GLB validation, .gltf packing, ids, scale). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	validateGlb, packGltf, slugId, suggestedScale, chooseModelFile, labelFromFilename, assertWithinCap, modelFileUrl,
	modelRepoPath, ModelFileError, MAX_MODEL_BYTES, MAX_LABEL_LENGTH,
} from '../src/scripts/admin/model-file.ts';
import { LIMITS } from '../src/data/scene.ts';
import * as F from './helpers/gltf-fixtures.ts';

const rejects = (fn: () => unknown, re?: RegExp) =>
	assert.throws(fn, (e: unknown) => e instanceof ModelFileError && (!re || re.test(e.message)), `expected ModelFileError ${re ?? ''}`);
const files = (o: Record<string, Uint8Array>) => new Map(Object.entries(o));

// Reads back what packGltf wrote, straight from the bytes (independent of validateGlb).
function readBack(glb: Uint8Array) {
	const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	const jl = dv.getUint32(12, true);
	const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + jl)).toString('utf8'));
	const binStart = 20 + jl;
	const hasBin = binStart < glb.length;
	return {
		json,
		jsonChunkLen: jl,
		binLen: hasBin ? dv.getUint32(binStart, true) : 0,
		binType: hasBin ? dv.getUint32(binStart + 4, true) : 0,
		bin: hasBin ? glb.subarray(binStart + 8) : new Uint8Array(0),
	};
}

// ---- validateGlb ----------------------------------------------------------------------------

test('validateGlb accepts a valid GLB and returns its JSON and BIN chunks', () => {
	const { json, bin } = validateGlb(F.makeBoxGlb());
	assert.equal((json.asset as { version: string }).version, '2.0');
	assert.ok(bin && bin.byteLength === 840, 'BIN chunk is the 840-byte box buffer');
	const pos = (json.accessors as Array<{ min?: number[]; max?: number[] }>)[0];
	assert.deepEqual(pos.max, [1, 0.5, 0.25]);
});

test('validateGlb accepts a GLB with an image inside the BIN chunk', () => {
	assert.doesNotThrow(() => validateGlb(F.makeBoxGlbWithImage()));
});

test('validateGlb: a GLB without a BIN chunk is valid and returns bin = null', () => {
	const { json } = F.boxGltf();
	const delGeometry = { asset: json.asset, scenes: [{ nodes: [] }] };
	const glb = F.encodeGlb(delGeometry, null);
	assert.equal(validateGlb(glb).bin, null);
});

test('validateGlb rejects every corrupt variant with a ModelFileError', () => {
	rejects(() => validateGlb(F.makeBadMagicGlb()), /not a \.glb|glTF/i);
	rejects(() => validateGlb(F.makeVersion1Glb()), /2\.0|version/i);
	rejects(() => validateGlb(F.makeWrongHeaderLengthGlb(16)), /length/i);
	rejects(() => validateGlb(F.makeWrongHeaderLengthGlb(-4)), /length/i);
	rejects(() => validateGlb(F.makeCutOffGlb()), /length|damaged/i);
	rejects(() => validateGlb(F.makeTruncatedJsonChunkGlb()), /JSON/i);
});

test('validateGlb rejects empty, tiny, random and text input', () => {
	rejects(() => validateGlb(new Uint8Array(0)), /too small/i);
	rejects(() => validateGlb(new Uint8Array(19)), /too small/i);
	rejects(() => validateGlb(Uint8Array.from(Buffer.from('{"asset":{"version":"2.0"}} this is a gltf, not a glb'))), /glTF|\.glb/i);
	rejects(() => validateGlb(F.TINY_PNG), /glTF|\.glb|small/i);
});

test('validateGlb works on a Uint8Array view with a non-zero byteOffset', () => {
	const glb = F.makeBoxGlb();
	const backing = new Uint8Array(glb.length + 13);
	backing.set(glb, 13);
	assert.doesNotThrow(() => validateGlb(backing.subarray(13)));
});

test('validateGlb rejects a first chunk that is not JSON, a chunk past the end, and non-object JSON', () => {
	const g = F.makeBoxGlb();
	const notJson = g.slice();
	new DataView(notJson.buffer).setUint32(16, F.CHUNK_BIN, true);
	rejects(() => validateGlb(notJson), /first chunk/i);
	const runPast = g.slice();
	new DataView(runPast.buffer).setUint32(12, 0x00ffffff, true);
	rejects(() => validateGlb(runPast), /chunk|damaged/i);
	rejects(() => validateGlb(F.encodeGlb([] as unknown as Record<string, unknown>, null)), /object|JSON/i);
});

test('validateGlb: asset.version must be 2.x', () => {
	const { json, bin } = F.boxGltf();
	rejects(() => validateGlb(F.encodeGlb({ ...json, asset: { version: '1.0' } }, bin)), /2\.x|glTF 2/i);
	rejects(() => validateGlb(F.encodeGlb({ ...json, asset: {} }, bin)), /2\.x|glTF 2/i);
	rejects(() => validateGlb(F.encodeGlb({ ...json, asset: undefined }, bin)), /2\.x|glTF 2/i);
	assert.doesNotThrow(() => validateGlb(F.encodeGlb({ ...json, asset: { version: '2.1' } }, bin)));
});

test('validateGlb rejects unsupported required extensions (Draco, Meshopt, KTX2, unknown) and names them', () => {
	rejects(() => validateGlb(F.makeDracoRequiredGlb()), /Draco.*KHR_draco_mesh_compression/);
	for (const [ext, re] of [
		['EXT_meshopt_compression', /Meshopt/],
		['KHR_meshopt_compression', /Meshopt/],
		['KHR_texture_basisu', /KTX2|Basis/],
		['VENDOR_made_up_extension', /VENDOR_made_up_extension/],
	] as const) {
		rejects(() => validateGlb(F.makeBoxGlb({ extra: { extensionsRequired: [ext] } })), re);
	}
});

test('validateGlb accepts supported required extensions and ignores extensionsUsed-only', () => {
	assert.doesNotThrow(() => validateGlb(F.makeBoxGlb({ extra: { extensionsRequired: ['KHR_texture_transform', 'KHR_materials_unlit'] } })));
	assert.doesNotThrow(() => validateGlb(F.makeBoxGlb({ extra: { extensionsUsed: ['KHR_draco_mesh_compression'] } })), 'Draco only "used" (optional) is not required');
});

test('validateGlb rejects external uris: https, data: and relative in buffers and images', () => {
	rejects(() => validateGlb(F.makeExternalHttpsUriGlb()), /internet|https/i);
	const { json, bin } = F.boxGltf();
	const withUri = (buffers: unknown, images?: unknown) => F.encodeGlb({ ...json, buffers, ...(images ? { images } : {}) }, bin);
	rejects(() => validateGlb(withUri([{ byteLength: 840, uri: 'http://example.invalid/a.bin' }])), /internet/i);
	rejects(() => validateGlb(withUri([{ byteLength: 840, uri: 'data:application/octet-stream;base64,AAAA' }])), /data:/i);
	rejects(() => validateGlb(withUri([{ byteLength: 840, uri: 'model.bin' }])), /external file/i);
	rejects(() => validateGlb(withUri([{ byteLength: 840 }], [{ uri: 'https://example.invalid/t.png' }])), /Image 0.*internet/i);
	rejects(() => validateGlb(withUri([{ byteLength: 840 }], [{ uri: 'tex.png' }])), /Image 0/i);
	rejects(() => validateGlb(withUri([{ byteLength: 840 }], [{ uri: 'data:image/png;base64,AAAA' }])), /Image 0.*data:/i);
});

test('validateGlb enforces the size cap first (before parsing anything)', () => {
	assert.equal(MAX_MODEL_BYTES, 25 * 1024 * 1024);
	assert.equal(MAX_MODEL_BYTES, 26_214_400, 'the cap is 25 MiB = 26,214,400 bytes');
	assert.ok(F.makeOversizedGlb().length > MAX_MODEL_BYTES, 'the oversized fixture exceeds 25 MiB');
	rejects(() => validateGlb(F.makeOversizedGlb()), /limit|MB/i);
	rejects(() => validateGlb(new Uint8Array(MAX_MODEL_BYTES + 1)), /MB/);
});

test('size cap boundary: exactly 25 MiB passes assertWithinCap, one byte more does not', () => {
	assert.doesNotThrow(() => assertWithinCap(MAX_MODEL_BYTES));
	rejects(() => assertWithinCap(MAX_MODEL_BYTES + 1), /25\.0 MB/);
	// A real GLB sized to exactly the cap validates; 4 bytes (one aligned unit) beyond is refused.
	const build = (extra: number) => {
		const { json, bin } = F.boxGltf({ extraBufferBytes: extra });
		return F.encodeGlb(json, F.makeConcat([bin, new Uint8Array(extra)]));
	};
	// the JSON text grows with the declared byteLength, so settle on the extra that hits the target length
	const sized = (target: number) => {
		let extra = target - build(0).length;
		for (let i = 0; i < 5; i++) extra += target - build(extra).length;
		return build(extra);
	};
	const exact = sized(MAX_MODEL_BYTES);
	assert.equal(exact.length, MAX_MODEL_BYTES);
	assert.doesNotThrow(() => validateGlb(exact), 'a GLB of exactly 25 MiB (26,214,400 B) is accepted');
	const over = sized(MAX_MODEL_BYTES + 4);
	assert.equal(over.length, MAX_MODEL_BYTES + 4);
	assert.equal(over.length, 26_214_404, 'the next 4-byte-aligned size above the cap');
	rejects(() => validateGlb(over), /25\.0 MB/);
	rejects(() => validateGlb(new Uint8Array(MAX_MODEL_BYTES + 1)), /25\.0 MB/);
	assert.ok(!/10\.0 MB/.test((() => { try { validateGlb(over); } catch (e) { return (e as Error).message; } return ''; })()), 'no leftover 10 MB text');
});

test('every ModelFileError message is a short user-facing sentence (no stack text, no token-like content)', () => {
	const bad = [F.makeBadMagicGlb(), F.makeVersion1Glb(), F.makeWrongHeaderLengthGlb(), F.makeCutOffGlb(), F.makeTruncatedJsonChunkGlb(), F.makeDracoRequiredGlb(), F.makeExternalHttpsUriGlb()];
	for (const b of bad) {
		try {
			validateGlb(b);
			assert.fail('should have thrown');
		} catch (e) {
			assert.ok(e instanceof ModelFileError);
			assert.ok(e.message.length > 10 && e.message.length < 220, e.message);
			assert.ok(!/at .*\.ts|undefined|\[object/.test(e.message), e.message);
		}
	}
});

// ---- packGltf -------------------------------------------------------------------------------

test('packGltf: embedded data: buffer -> a valid GLB with the same geometry', () => {
	const text = F.makeEmbeddedGltf();
	const glb = packGltf(JSON.parse(text), files({}));
	const info = validateGlb(glb);
	assert.equal(glb.length % 4, 0);
	const original = F.boxGltf().bin;
	assert.deepEqual(Array.from(info.bin!.subarray(0, original.length)), Array.from(original), 'BIN chunk carries the box buffer bytes');
	const acc = (info.json.accessors as Array<{ min?: number[]; max?: number[] }>)[0];
	assert.deepEqual([acc.min, acc.max], [[...F.BOX_MIN], [...F.BOX_MAX]], 'bounding box unchanged');
	assert.equal((info.json.buffers as unknown[]).length, 1);
	assert.equal((info.json.buffers as Array<{ uri?: string }>)[0].uri, undefined, 'no uri left on the buffer');
});

test('packGltf: embedded buffer + embedded PNG -> image becomes a bufferView with sniffed mimeType, no uri', () => {
	const glb = packGltf(JSON.parse(F.makeEmbeddedGltf({ withImage: true })), files({}));
	const { json, bin } = validateGlb(glb);
	const img = (json.images as Array<{ uri?: string; bufferView?: number; mimeType?: string }>)[0];
	assert.equal(img.uri, undefined);
	assert.equal(img.mimeType, 'image/png');
	const view = (json.bufferViews as Array<{ buffer: number; byteOffset: number; byteLength: number }>)[img.bufferView!];
	assert.equal(view.buffer, 0);
	assert.equal(view.byteOffset % 4, 0, 'image view is 4-byte aligned');
	assert.deepEqual(Array.from(bin!.subarray(view.byteOffset, view.byteOffset + view.byteLength)), Array.from(F.TINY_PNG), 'PNG bytes intact');
});

test('packGltf: external model.bin + tex.png from the picked files', () => {
	const ext = F.makeExternalGltf();
	const glb = packGltf(JSON.parse(ext.gltf), files(ext.files));
	const { json, bin } = validateGlb(glb);
	const img = (json.images as Array<{ bufferView: number; mimeType: string }>)[0];
	const view = (json.bufferViews as Array<{ byteOffset: number; byteLength: number }>)[img.bufferView];
	assert.equal(img.mimeType, 'image/png');
	assert.deepEqual(Array.from(bin!.subarray(view.byteOffset, view.byteOffset + view.byteLength)), Array.from(F.TINY_PNG));
	// geometry views still land on the original bytes
	const posView = (json.bufferViews as Array<{ byteOffset: number; byteLength: number }>)[0];
	assert.deepEqual(Array.from(bin!.subarray(posView.byteOffset, posView.byteOffset + posView.byteLength)), Array.from(ext.files['model.bin'].subarray(0, posView.byteLength)));
});

test('packGltf: files are matched by exact name, by base name, with ./ and %20 forms', () => {
	const ext = F.makeExternalGltf();
	const doc = JSON.parse(ext.gltf);
	doc.buffers[0].uri = './sub/my%20model.bin';
	assert.doesNotThrow(() => packGltf(doc, files({ 'my model.bin': ext.files['model.bin'], 'tex.png': ext.files['tex.png'] })));
	doc.buffers[0].uri = 'model.bin';
	assert.doesNotThrow(() => packGltf(doc, files({ 'model.bin': ext.files['model.bin'], 'tex.png': ext.files['tex.png'] })));
});

test('packGltf: a missing .bin gives an error that names the file', () => {
	const doc = JSON.parse(F.makeExternalMissingGltf());
	rejects(() => packGltf(doc, files({})), /"missing\.bin".*not picked/);
	const ext = F.makeExternalGltf();
	rejects(() => packGltf(JSON.parse(ext.gltf), files({ 'model.bin': ext.files['model.bin'] })), /"tex\.png"/);
	rejects(() => packGltf(JSON.parse(ext.gltf), files({ 'tex.png': ext.files['tex.png'] })), /"model\.bin"/);
});

test('packGltf: a .bin shorter than the declared buffer is refused', () => {
	const ext = F.makeExternalGltf();
	rejects(() => packGltf(JSON.parse(ext.gltf), files({ 'model.bin': ext.files['model.bin'].subarray(0, 100), 'tex.png': ext.files['tex.png'] })), /shorter|truncated/i);
});

test('packGltf: https uri in a .gltf is refused, relative uri wins over nothing', () => {
	rejects(() => packGltf(JSON.parse(F.makeExternalHttpsUriGltf()), files({})), /internet|https/i);
	const doc = JSON.parse(F.makeExternalGltf().gltf);
	doc.buffers[0].uri = 'https://example.invalid/model.bin';
	rejects(() => packGltf(doc, files({})), /internet|https/i);
	doc.buffers[0].uri = '//example.invalid/model.bin';
	rejects(() => packGltf(doc, files({})), /external|internet|https|not picked/i);
});

test('packGltf: refuses a non-image "image", garbage data: URIs, and non-glTF input', () => {
	const ext = F.makeExternalGltf();
	rejects(() => packGltf(JSON.parse(ext.gltf), files({ 'model.bin': ext.files['model.bin'], 'tex.png': Uint8Array.from([1, 2, 3, 4, 5]) })), /PNG, JPEG or WebP/);
	const doc = JSON.parse(F.makeEmbeddedGltf());
	doc.buffers[0].uri = 'data:application/octet-stream;base64,@@@';
	rejects(() => packGltf(doc, files({})), /data: URI/);
	rejects(() => packGltf(null, files({})), /not a glTF/i);
	rejects(() => packGltf([], files({})), /not a glTF/i);
	rejects(() => packGltf('text', files({})), /not a glTF/i);
});

test('packGltf: required extensions and asset version are checked as for a GLB', () => {
	const doc = JSON.parse(F.makeEmbeddedGltf());
	rejects(() => packGltf({ ...doc, extensionsRequired: ['KHR_draco_mesh_compression'] }, files({})), /Draco/);
	rejects(() => packGltf({ ...doc, asset: { version: '1.0' } }, files({})), /2\.x|2\.0/);
});

test('packGltf does not mutate its input document', () => {
	const doc = JSON.parse(F.makeEmbeddedGltf({ withImage: true }));
	const before = JSON.stringify(doc);
	packGltf(doc, files({}));
	assert.equal(JSON.stringify(doc), before);
});

test('packGltf: multiple buffers are merged with aligned offsets and re-pointed views', () => {
	// two buffers of lengths 5 and 7 (not multiples of 4), one view into each
	const a = Uint8Array.from([1, 2, 3, 4, 5]);
	const b = Uint8Array.from([11, 12, 13, 14, 15, 16, 17]);
	const doc = {
		asset: { version: '2.0' },
		buffers: [{ byteLength: 5, uri: 'a.bin' }, { byteLength: 7, uri: 'b.bin' }],
		bufferViews: [{ buffer: 0, byteOffset: 1, byteLength: 3 }, { buffer: 1, byteOffset: 2, byteLength: 4 }],
	};
	const glb = packGltf(doc, files({ 'a.bin': a, 'b.bin': b }));
	const { json, bin } = validateGlb(glb);
	assert.equal(glb.length % 4, 0);
	assert.equal((json.buffers as unknown[]).length, 1);
	const views = json.bufferViews as Array<{ buffer: number; byteOffset: number; byteLength: number }>;
	assert.ok(views.every((v) => v.buffer === 0), 'all views point at buffer 0');
	const slice = (v: { byteOffset: number; byteLength: number }) => Array.from(bin!.subarray(v.byteOffset, v.byteOffset + v.byteLength));
	assert.deepEqual(slice(views[0]), [2, 3, 4], 'view 0 reads a[1..4]');
	assert.deepEqual(slice(views[1]), [13, 14, 15, 16], 'view 1 reads b[2..6]');
	assert.ok(views[1].byteOffset >= 8, 'second buffer starts after the first, aligned to 4');
	const binBytes = bin!.length;
	assert.equal(binBytes % 4, 0, 'BIN chunk length is padded to 4');
	assert.equal((json.buffers as Array<{ byteLength: number }>)[0].byteLength <= binBytes, true);
});

test('packGltf output has a correct container: header length, JSON padded with spaces, BIN padded with zeros', () => {
	const glb = packGltf(JSON.parse(F.makeEmbeddedGltf({ withImage: true })), files({}));
	const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	assert.equal(dv.getUint32(0, true), F.GLB_MAGIC);
	assert.equal(dv.getUint32(4, true), 2);
	assert.equal(dv.getUint32(8, true), glb.length);
	const back = readBack(glb);
	assert.equal(back.jsonChunkLen % 4, 0);
	assert.equal(back.binType, F.CHUNK_BIN);
	assert.equal(back.binLen % 4, 0);
	assert.equal(back.bin.length, back.binLen, 'BIN chunk runs to the end of the file');
	// padding bytes after the real JSON text are spaces (0x20), not NUL
	const jsonText = Buffer.from(glb.subarray(20, 20 + back.jsonChunkLen)).toString('utf8');
	assert.doesNotThrow(() => JSON.parse(jsonText), 'padded JSON text still parses');
	assert.ok(!jsonText.includes('\u0000'));
});

test('packGltf: a .gltf with no buffers at all packs to a GLB without BIN, and validates', () => {
	const glb = packGltf({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] }, files({}));
	assert.equal(validateGlb(glb).bin, null);
});

test('packGltf rejects an over-cap result with the size message, and accepts one just under it', () => {
	const big = new Uint8Array(MAX_MODEL_BYTES + 1024);
	const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: big.length, uri: 'big.bin' }], bufferViews: [{ buffer: 0, byteLength: 16 }] };
	rejects(() => packGltf(doc, files({ 'big.bin': big })), /limit|MB/i);
	const ok = new Uint8Array(MAX_MODEL_BYTES - 4096);
	assert.doesNotThrow(() => packGltf({ ...doc, buffers: [{ byteLength: ok.length, uri: 'big.bin' }] }, files({ 'big.bin': ok })));
});

test('packGltf round-trips the packed box twice: pack(pack-output as gltf) is not needed, but GLB -> validate is stable', () => {
	const ext = F.makeExternalGltf();
	const a = packGltf(JSON.parse(ext.gltf), files(ext.files));
	const b = packGltf(JSON.parse(ext.gltf), files(ext.files));
	assert.deepEqual(Array.from(a), Array.from(b), 'packing is deterministic');
	assert.deepEqual(validateGlb(a).json, validateGlb(b).json);
});

// ---- slugId ---------------------------------------------------------------------------------

test('slugId: lowercase [a-z0-9-], <= 48 chars, never empty, accents folded', () => {
	const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
	for (const [name, expected] of [
		['My Chair', 'my-chair'],
		['  Kitchen_Table  #2 ', 'kitchen-table-2'],
		['Café Étagère', 'cafe-etagere'],
		['---', 'model'],
		['', 'model'],
		['日本語', 'model'],
		['😀😀', 'model'],
		['A'.repeat(100), 'a'.repeat(48)],
		['UPPER lower 123', 'upper-lower-123'],
	] as const) {
		const id = slugId(name, []);
		assert.equal(id, expected, JSON.stringify(name));
		assert.match(id, ID_RE);
		assert.ok(id.length <= 48);
	}
});

test('slugId: a 48-char cut never ends in "-"', () => {
	const name = `${'a'.repeat(47)} b`;
	const id = slugId(name, []);
	assert.ok(!id.endsWith('-'), id);
	assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test('slugId: unique among taken ids, case-insensitive, with -2, -3 suffixes', () => {
	assert.equal(slugId('Chair', ['chair']), 'chair-2');
	assert.equal(slugId('Chair', ['chair', 'chair-2']), 'chair-3');
	assert.equal(slugId('Chair', ['CHAIR']), 'chair-2');
	assert.equal(slugId('Chair', new Set(['chair', 'chair-2', 'chair-3', 'chair-4'])), 'chair-5');
	assert.equal(slugId('Chair', ['table']), 'chair');
	assert.equal(slugId('', ['model']), 'model-2');
	// a long name that collides still yields a valid id (suffix appended after the 48 cut)
	const long = 'x'.repeat(60);
	const id = slugId(long, ['x'.repeat(48)]);
	assert.equal(id, `${'x'.repeat(48)}-2`);
});

test('slugId: the id is usable as a path component (no dots, slashes, spaces)', () => {
	for (const name of ['../../etc/passwd', 'a/b\\c', 'x.glb', 'a b', '%2e%2e', 'con:aux']) {
		const id = slugId(name, []);
		assert.match(id, /^[a-z0-9-]+$/, `${name} -> ${id}`);
		assert.equal(modelRepoPath(id), `public/models/${id}.glb`);
		assert.equal(modelFileUrl(id), `/models/${id}.glb`);
	}
});

// ---- suggestedScale / labels / chooseModelFile ----------------------------------------------

test('suggestedScale: largest side ~ 1 m, two significant digits, clamped to LIMITS', () => {
	assert.equal(suggestedScale([2, 1, 0.5]), 0.5);
	assert.equal(suggestedScale([1, 1, 1]), 1);
	assert.equal(suggestedScale([3, 1, 1]), 0.33);
	assert.equal(suggestedScale([0.5, 0.25, 0.1]), 2);
	assert.equal(suggestedScale([100000, 1, 1]), LIMITS.minScale, 'huge model clamps to the minimum scale');
	assert.equal(suggestedScale([0.0001, 0.0001, 0.0001]), LIMITS.maxScale, 'tiny model clamps to the maximum scale');
	for (const bad of [[0, 0, 0], [NaN, 1, 1], [Infinity, 1, 1], [-1, -1, -1]] as Array<[number, number, number]>) {
		assert.equal(suggestedScale(bad), 1, `degenerate ${JSON.stringify(bad)} -> 1`);
	}
});

test('suggestedScale always lands inside LIMITS', () => {
	for (const s of [1e-9, 0.01, 0.2, 1, 7, 49, 51, 1e3, 1e9]) {
		const v = suggestedScale([s, s / 2, s / 3]);
		assert.ok(v >= LIMITS.minScale && v <= LIMITS.maxScale, `${s} -> ${v}`);
	}
});

test('labelFromFilename: extension dropped, separators become spaces, capped, never empty', () => {
	assert.equal(labelFromFilename('my_chair-v2.glb'), 'my chair v2');
	assert.equal(labelFromFilename('C:\\models\\Sofa.GLTF'), 'Sofa');
	assert.equal(labelFromFilename('/tmp/a/b/lamp.glb'), 'lamp');
	assert.equal(labelFromFilename('.glb'), 'Model');
	assert.equal(labelFromFilename(''), 'Model');
	assert.equal(labelFromFilename(`${'x'.repeat(200)}.glb`).length, MAX_LABEL_LENGTH);
});

test('chooseModelFile: one .glb, or one .gltf with companions, else an error', () => {
	assert.deepEqual(chooseModelFile(['a.glb']), { main: 'a.glb', kind: 'glb' });
	assert.deepEqual(chooseModelFile(['A.GLB']), { main: 'A.GLB', kind: 'glb' });
	assert.deepEqual(chooseModelFile(['a.gltf', 'a.bin', 'tex.png']), { main: 'a.gltf', kind: 'gltf' });
	for (const names of [[], ['a.bin'], ['tex.png', 'a.bin'], ['a.glb', 'b.glb'], ['a.gltf', 'b.gltf'], ['a.glb', 'a.gltf'], ['a.glb', 'tex.png']]) {
		const r = chooseModelFile(names);
		assert.ok('error' in r && r.error.length > 10, JSON.stringify(names));
	}
});

test('no .gltf can smuggle a path: modelRepoPath/modelFileUrl only ever use the slug', () => {
	const id = slugId('../../.github/workflows/deploy', []);
	assert.equal(id, 'github-workflows-deploy');
	assert.ok(!modelRepoPath(id).includes('..'));
});

// ---- m6: only real PNG/JPEG/WebP images; the declared MIME type is not trusted ------------------------------

const imgDoc = (image: Record<string, unknown>) => ({
	asset: { version: '2.0' },
	buffers: [{ byteLength: 4, uri: 'a.bin' }],
	bufferViews: [{ buffer: 0, byteLength: 4 }],
	images: [image],
});
const fileMap = (extra: Record<string, Uint8Array>) => files({ 'a.bin': Uint8Array.from([1, 2, 3, 4]), ...extra });
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = Uint8Array.from(Buffer.from('GIF89a......', 'latin1'));
const SVG = Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));

test('packGltf (m6): PNG, JPEG and WebP are accepted and mimeType is written from the SNIFFED type', () => {
	for (const [bytes, mime] of [[F.TINY_PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']] as const) {
		const glb = packGltf(imgDoc({ uri: 'p.img' }), fileMap({ 'p.img': bytes }));
		const { json } = validateGlb(glb);
		assert.equal((json.images as Array<{ mimeType: string }>)[0].mimeType, mime);
	}
});

test('packGltf (m6): a lying mimeType is overridden by the sniffed one', () => {
	const glb = packGltf(imgDoc({ uri: 'p.png', mimeType: 'image/jpeg' }), fileMap({ 'p.png': F.TINY_PNG }));
	assert.equal((validateGlb(glb).json.images as Array<{ mimeType: string }>)[0].mimeType, 'image/png');
});

test('packGltf (m6): GIF, SVG, KTX2-looking, empty and random bytes are refused whatever the declared type says', () => {
	for (const [bytes, declared] of [[GIF, 'image/gif'], [SVG, 'image/svg+xml'], [Uint8Array.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30]), 'image/ktx2'], [new Uint8Array(0), 'image/png'], [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'image/png']] as const) {
		rejects(() => packGltf(imgDoc({ uri: 'p.img', mimeType: declared }), fileMap({ 'p.img': bytes })), /PNG, JPEG or WebP/);
	}
});

test('packGltf (m6): a data: image of type image/svg+xml or image/gif is refused too', () => {
	const svg = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;
	rejects(() => packGltf(imgDoc({ uri: svg }), fileMap({})), /PNG, JPEG or WebP/);
	const gif = `data:image/gif;base64,${Buffer.from(GIF).toString('base64')}`;
	rejects(() => packGltf(imgDoc({ uri: gif }), fileMap({})), /PNG, JPEG or WebP/);
	const png = `data:image/png;base64,${Buffer.from(F.TINY_PNG).toString('base64')}`;
	assert.doesNotThrow(() => packGltf(imgDoc({ uri: png }), fileMap({})));
});

test('packGltf (m6): a PNG declared as "application/octet-stream" in a data: uri is still accepted (sniffed)', () => {
	const png = `data:application/octet-stream;base64,${Buffer.from(F.TINY_PNG).toString('base64')}`;
	const glb = packGltf(imgDoc({ uri: png }), fileMap({}));
	assert.equal((validateGlb(glb).json.images as Array<{ mimeType: string }>)[0].mimeType, 'image/png');
});

// ---- n6: buffer byteLength must be a positive integer ---------------------------------------------------------

test('packGltf (n6): a buffer byteLength that is negative, zero, fractional, NaN-like or not a number is refused as invalid', () => {
	const bin = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
	for (const byteLength of [-1, 0, 2.5, '8', null, Number.MAX_SAFE_INTEGER + 2]) {
		const doc = { asset: { version: '2.0' }, buffers: [{ byteLength, uri: 'a.bin' }], bufferViews: [{ buffer: 0, byteLength: 4 }] };
		rejects(() => packGltf(doc, files({ 'a.bin': bin })), /invalid length|shorter|invalid/i);
	}
});

test('packGltf (n6): a valid byteLength smaller than the file trims to byteLength; a missing byteLength falls back to the file length', () => {
	const bin = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
	const glb = packGltf({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'a.bin' }], bufferViews: [{ buffer: 0, byteLength: 4 }] }, files({ 'a.bin': bin }));
	assert.equal(validateGlb(glb).bin!.length, 4);
	const lenient = packGltf({ asset: { version: '2.0' }, buffers: [{ uri: 'a.bin' }], bufferViews: [] }, files({ 'a.bin': bin }));
	assert.equal(validateGlb(lenient).bin!.length, 8, 'no byteLength: the whole picked file is used (the spec requires one, but nothing breaks)');
});

// ---- n7: non-base64 data: URIs are refused ----------------------------------------------------------------------

test('packGltf (n7): a data: buffer or image without ;base64 is refused (glTF requires base64)', () => {
	const plainBuffer = { asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'data:application/octet-stream,%01%02%03%04' }], bufferViews: [{ buffer: 0, byteLength: 4 }] };
	rejects(() => packGltf(plainBuffer, files({})), /not base64/i);
	rejects(() => packGltf(imgDoc({ uri: 'data:image/png,%89PNG' }), fileMap({})), /not base64/i);
	const ok = { ...plainBuffer, buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AQIDBA==' }] };
	assert.doesNotThrow(() => packGltf(ok, files({})));
	assert.deepEqual(Array.from(validateGlb(packGltf(ok, files({}))).bin!.subarray(0, 4)), [1, 2, 3, 4]);
});

// ---- n5 / n2: label clipping by code point, accent folding ---------------------------------------------------------

test('labelFromFilename (n5): clipping never cuts an emoji (surrogate pair) in half', () => {
	const label = labelFromFilename(`${'a'.repeat(59)}😀😀😀.glb`);
	assert.ok(!/[\ud800-\udbff]$/.test(label) && !/^[\udc00-\udfff]/.test(label), 'no lone surrogate at the cut');
	assert.equal(Array.from(label).length, MAX_LABEL_LENGTH);
	assert.equal(JSON.parse(JSON.stringify(label)), label);
	assert.doesNotThrow(() => encodeURIComponent(label), 'valid UTF-16, so it can be stored and sent');
});

test('slugId (n2): accents are folded (combining marks removed), not turned into dashes', () => {
	assert.equal(slugId('Crème Brûlée Ñandú', []), 'creme-brulee-nandu');
	assert.equal(slugId('e\u0301cole', []), 'ecole');
});

test('model-limits: suggestedScale reaches 0.001 for huge models and never goes below it', () => {
	assert.equal(suggestedScale([1000, 1, 1]), 0.001);
	assert.equal(suggestedScale([500, 1, 1]), 0.002);
	assert.equal(suggestedScale([100000, 1, 1]), 0.001);
});
