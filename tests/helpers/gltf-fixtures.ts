// Test helper (no tests in here): builds minimal glTF 2.0 / GLB fixtures, valid and corrupt, in pure Node.
// Erasable TypeScript only, no dependencies. Ported from the removed scripts/make-test-model.mjs.
//
// Every valid model is the same box, SIZE = 2 x 1 x 0.5 units, centred on the origin:
// POSITION min = [-1, -0.5, -0.25], max = [1, 0.5, 0.25] (written to the accessor, so a loader/validator can read it).

export const BOX_SIZE = [2, 1, 0.5] as const;
export const BOX_MIN = [-1, -0.5, -0.25] as const;
export const BOX_MAX = [1, 0.5, 0.25] as const;

export const GLB_MAGIC = 0x46546c67; // "glTF"
export const CHUNK_JSON = 0x4e4f534a; // "JSON"
export const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** One MiB, for the size-cap helpers. */
export const MIB = 1024 * 1024;

type Json = Record<string, unknown>;

/** 1x1 opaque red PNG, hard-coded (valid signature, IHDR, IDAT, IEND with correct CRCs). */
export const TINY_PNG: Uint8Array = Uint8Array.from(
	Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64',
	),
);

// ---------------------------------------------------------------------------------------------------------------
// Low-level helpers

const pad4 = (b: Uint8Array, fill = 0): Uint8Array => {
	const extra = (4 - (b.length % 4)) % 4;
	if (!extra) return b;
	const out = new Uint8Array(b.length + extra).fill(fill);
	out.set(b, 0);
	return out;
};

export const makeConcat = (parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

const u32 = (...values: number[]): Uint8Array => {
	const b = new Uint8Array(values.length * 4);
	const dv = new DataView(b.buffer);
	values.forEach((v, i) => dv.setUint32(i * 4, v, true));
	return b;
};

const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

export interface EncodeGlbOptions {
	/** Replace the magic number (default "glTF"). */
	magic?: number;
	/** Replace the container version (default 2). */
	version?: number;
	/** Added to the (correct) total length written in the header. */
	headerLengthDelta?: number;
	/** Write this exact JSON text (already padded or not) instead of JSON.stringify(json). */
	rawJsonText?: string;
	/** Omit the BIN chunk entirely. */
	noBin?: boolean;
}

/** Assemble a GLB: 12-byte header, JSON chunk (space padded), optional BIN chunk (zero padded). */
export function encodeGlb(json: Json, bin: Uint8Array | null, opts: EncodeGlbOptions = {}): Uint8Array {
	const jsonBytes = pad4(utf8(opts.rawJsonText ?? JSON.stringify(json)), 0x20);
	const parts: Uint8Array[] = [u32(jsonBytes.length, CHUNK_JSON), jsonBytes];
	if (bin && !opts.noBin) {
		const binBytes = pad4(bin);
		parts.push(u32(binBytes.length, CHUNK_BIN), binBytes);
	}
	const body = makeConcat(parts);
	const total = 12 + body.length;
	return makeConcat([u32(opts.magic ?? GLB_MAGIC, opts.version ?? 2, total + (opts.headerLengthDelta ?? 0)), body]);
}

// ---------------------------------------------------------------------------------------------------------------
// The box (24 vertices so each face has a flat normal and its own UVs)

interface BoxGeometry {
	position: Uint8Array;
	normal: Uint8Array;
	texcoord: Uint8Array;
	index: Uint8Array;
}

function boxGeometry(): BoxGeometry {
	const [hx, hy, hz] = [BOX_SIZE[0] / 2, BOX_SIZE[1] / 2, BOX_SIZE[2] / 2];
	// normal, then four corners counter-clockwise seen from outside
	const faces: Array<[number[], number[][]]> = [
		[[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
		[[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
		[[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
		[[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
		[[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
		[[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
	];
	const uv = [0, 1, 1, 1, 1, 0, 0, 0];
	const positions: number[] = [];
	const normals: number[] = [];
	const texcoords: number[] = [];
	const indices: number[] = [];
	faces.forEach(([normal, corners], f) => {
		for (const corner of corners) {
			positions.push(...corner);
			normals.push(...normal);
		}
		texcoords.push(...uv);
		const o = f * 4;
		indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
	});
	const bytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	return {
		position: bytes(new Float32Array(positions)),
		normal: bytes(new Float32Array(normals)),
		texcoord: bytes(new Float32Array(texcoords)),
		index: bytes(new Uint16Array(indices)),
	};
}

export interface BoxJsonOptions {
	/** `uri` of the single buffer; omit for a GLB (the buffer is the BIN chunk). */
	bufferUri?: string;
	/** Add a material with a baseColorTexture pointing at an image with this `uri`. */
	imageUri?: string;
	/** Add a material with a baseColorTexture pointing at an image stored as a bufferView of this buffer (GLB). */
	imageInBuffer?: { byteLength: number; mimeType: string };
	/** Extra top-level keys merged into the JSON (e.g. extensionsRequired). */
	extra?: Json;
	/** Extra bytes the buffer is declared to have (oversized builder); the BIN chunk must carry them. */
	extraBufferBytes?: number;
}

/**
 * The glTF JSON for the box plus the packed binary buffer it describes. The buffer holds
 * positions, normals, texcoords, indices (each 4-byte aligned), then optional embedded image bytes.
 */
export function boxGltf(opts: BoxJsonOptions = {}): { json: Json; bin: Uint8Array } {
	const g = boxGeometry();
	const segments = [pad4(g.position), pad4(g.normal), pad4(g.texcoord), pad4(g.index)];
	const lengths = [g.position.length, g.normal.length, g.texcoord.length, g.index.length];
	const targets = [34962, 34962, 34962, 34963];
	const bufferViews: Json[] = [];
	let offset = 0;
	segments.forEach((seg, i) => {
		bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: lengths[i], target: targets[i] });
		offset += seg.length;
	});
	const images: Json[] = [];
	const textures: Json[] = [];
	let imageBytes: Uint8Array | null = null;
	const material: Json = {
		name: 'box-mat',
		pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.4, 1], metallicFactor: 0, roughnessFactor: 0.9 },
	};
	if (opts.imageUri) {
		images.push({ uri: opts.imageUri });
	} else if (opts.imageInBuffer) {
		bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: opts.imageInBuffer.byteLength });
		images.push({ bufferView: bufferViews.length - 1, mimeType: opts.imageInBuffer.mimeType });
		imageBytes = new Uint8Array(opts.imageInBuffer.byteLength);
		offset += pad4(imageBytes).length;
	}
	if (images.length) {
		textures.push({ source: 0 });
		(material.pbrMetallicRoughness as Json).baseColorTexture = { index: 0 };
	}
	const bin = makeConcat([...segments, ...(imageBytes ? [pad4(imageBytes)] : [])]);
	const buffer: Json = { byteLength: bin.length + (opts.extraBufferBytes ?? 0) };
	if (opts.bufferUri !== undefined) buffer.uri = opts.bufferUri;
	const attributes: Json = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 };
	const json: Json = {
		asset: { version: '2.0', generator: 'tests/helpers/gltf-fixtures.ts' },
		scene: 0,
		scenes: [{ nodes: [0] }],
		nodes: [{ mesh: 0, name: 'box' }],
		meshes: [{ primitives: [{ attributes, indices: 3, material: 0 }] }],
		materials: [material],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [...BOX_MIN], max: [...BOX_MAX] },
			{ bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
			{ bufferView: 2, componentType: 5126, count: 24, type: 'VEC2' },
			{ bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
		],
		bufferViews,
		buffers: [buffer],
		...(images.length ? { images, textures } : {}),
		...(opts.extra ?? {}),
	};
	return { json, bin };
}

// ---------------------------------------------------------------------------------------------------------------
// Valid fixtures

/** A valid GLB: the 2 x 1 x 0.5 box, JSON + BIN chunks. */
export function makeBoxGlb(opts: { extra?: Json } = {}): Uint8Array {
	const { json, bin } = boxGltf({ extra: opts.extra });
	return encodeGlb(json, bin);
}

/** A valid GLB whose texture image (the TINY_PNG) lives inside the BIN chunk as a bufferView. */
export function makeBoxGlbWithImage(): Uint8Array {
	const { json, bin } = boxGltf({ imageInBuffer: { byteLength: TINY_PNG.length, mimeType: 'image/png' } });
	// put the real PNG bytes where the image bufferView points (last bufferView, after the geometry)
	const views = json.bufferViews as Array<{ byteOffset: number; byteLength: number }>;
	const view = views[views.length - 1];
	bin.set(TINY_PNG, view.byteOffset);
	return encodeGlb(json, bin);
}

/** A .gltf (JSON text) whose only buffer is an embedded `data:` URI. With `withImage`, the PNG is a `data:` URI too. */
export function makeEmbeddedGltf(opts: { withImage?: boolean } = {}): string {
	const imageUri = opts.withImage ? `data:image/png;base64,${toBase64(TINY_PNG)}` : undefined;
	const { json, bin } = boxGltf({ imageUri });
	(json.buffers as Json[])[0].uri = `data:application/octet-stream;base64,${toBase64(bin)}`;
	return JSON.stringify(json, null, 2);
}

export interface ExternalGltf {
	/** The .gltf JSON text. References `model.bin` and `tex.png` by relative uri. */
	gltf: string;
	/** Companion files keyed by the exact uri used in the .gltf. */
	files: { 'model.bin': Uint8Array; 'tex.png': Uint8Array };
	/** Convenience: the names the .gltf refers to. */
	uris: { bin: 'model.bin'; image: 'tex.png' };
}

/** A .gltf that references an external `model.bin` and a PNG `tex.png` (return the files too). */
export function makeExternalGltf(): ExternalGltf {
	const { json, bin } = boxGltf({ bufferUri: 'model.bin', imageUri: 'tex.png' });
	return {
		gltf: JSON.stringify(json, null, 2),
		files: { 'model.bin': bin, 'tex.png': TINY_PNG },
		uris: { bin: 'model.bin', image: 'tex.png' },
	};
}

/** A .gltf referencing `missing.bin` (and nothing else), for the "picked without its .bin" error. */
export function makeExternalMissingGltf(): string {
	const { json } = boxGltf({ bufferUri: 'missing.bin' });
	return JSON.stringify(json, null, 2);
}

// ---------------------------------------------------------------------------------------------------------------
// Corrupt / unsupported fixtures

/** Magic is "glTX" instead of "glTF". */
export function makeBadMagicGlb(): Uint8Array {
	const { json, bin } = boxGltf();
	return encodeGlb(json, bin, { magic: 0x58546c67 });
}

/** Container version 1 (the legacy binary glTF). */
export function makeVersion1Glb(): Uint8Array {
	const { json, bin } = boxGltf();
	return encodeGlb(json, bin, { version: 1 });
}

/** Header length does not match the byte length. `delta` > 0: header claims more bytes than the file has. */
export function makeWrongHeaderLengthGlb(delta = 16): Uint8Array {
	const { json, bin } = boxGltf();
	return encodeGlb(json, bin, { headerLengthDelta: delta });
}

/** The file is cut off mid-way through the JSON chunk; header and chunk lengths still say the original size. */
export function makeCutOffGlb(): Uint8Array {
	const full = makeBoxGlb();
	return full.slice(0, 12 + 8 + 40);
}

/** Header and chunk lengths are consistent, but the JSON text is truncated, so it does not parse. */
export function makeTruncatedJsonChunkGlb(): Uint8Array {
	const { json, bin } = boxGltf();
	const text = JSON.stringify(json);
	return encodeGlb(json, bin, { rawJsonText: text.slice(0, Math.floor(text.length / 2)), noBin: true });
}

/** Requires KHR_draco_mesh_compression (unsupported by the importer). Structure is otherwise a valid box GLB. */
export function makeDracoRequiredGlb(): Uint8Array {
	const { json, bin } = boxGltf({
		extra: {
			extensionsUsed: ['KHR_draco_mesh_compression'],
			extensionsRequired: ['KHR_draco_mesh_compression'],
		},
	});
	return encodeGlb(json, bin);
}

/** A GLB whose buffer points to an external `https://` uri (a remote fetch the importer must refuse). */
export function makeExternalHttpsUriGlb(): Uint8Array {
	const { json, bin } = boxGltf({ bufferUri: 'https://example.invalid/model.bin' });
	return encodeGlb(json, bin);
}

/** A .gltf whose image points to an external `https://` uri. The buffer is embedded so only the image is remote. */
export function makeExternalHttpsUriGltf(): string {
	const real = boxGltf({ imageUri: 'https://example.invalid/tex.png' });
	(real.json.buffers as Json[])[0].uri = `data:application/octet-stream;base64,${toBase64(real.bin)}`;
	return JSON.stringify(real.json, null, 2);
}

/**
 * A structurally valid GLB padded so the total size exceeds `minBytes` (default 10 MiB + 1 MiB).
 * The padding is zeros in the BIN chunk and the buffer's byteLength is updated to match.
 */
export function makeOversizedGlb(minBytes = 11 * MIB): Uint8Array {
	const small = boxGltf();
	const probe = encodeGlb(small.json, small.bin).length;
	const extra = Math.max(0, minBytes - probe) + 4;
	const { json, bin } = boxGltf({ extraBufferBytes: extra });
	const padded = makeConcat([bin, new Uint8Array(extra)]);
	return encodeGlb(json, padded);
}

/** Header check used by the fixture self-test and the task-folder script: returns what the header says. */
export function readGlbHeader(bytes: Uint8Array): { magic: string; version: number; length: number; byteLength: number } {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		magic: String.fromCharCode(...bytes.slice(0, 4)),
		version: dv.getUint32(4, true),
		length: dv.getUint32(8, true),
		byteLength: bytes.byteLength,
	};
}
