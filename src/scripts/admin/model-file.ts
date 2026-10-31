// Model files for the admin library: validating a GLB, packing a .gltf (+ .bin / textures) into one GLB,
// ids, labels and the suggested scale. Pure TypeScript with only erasable syntax and no DOM/three/Astro
// imports, so Node can import it directly. Only .glb files are ever stored in the repository.
import { LIMITS } from '../../data/scene.ts';

/** Size cap of the final GLB. */
export const MAX_MODEL_BYTES = 10 * 1024 * 1024;
export const MAX_LABEL_LENGTH = 60;

/** The message of a ModelFileError is meant to be shown to the user as is. */
export class ModelFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelFileError';
	}
}

const fail = (message: string): never => {
	throw new ModelFileError(message);
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// --- Paths and names ---------------------------------------------------------------------------------

/** Site path of a model's file. Always derived from the id, never from the user's filename. */
export const modelFileUrl = (id: string) => `/models/${id}.glb`;
/** Repository path of a model's file. */
export const modelRepoPath = (id: string) => `public/models/${id}.glb`;

/** At most `max` characters (code points), so an emoji is never cut in half. */
export const clipLabel = (text: string, max = MAX_LABEL_LENGTH) => Array.from(text).slice(0, max).join('');

/** A model name suggested from a filename: extension dropped, "_" / "-" / "." become spaces. */
export function labelFromFilename(filename: string): string {
	const base = filename.replace(/^.*[\\/]/, '').replace(/\.(glb|gltf)$/i, '');
	const label = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
	return clipLabel(label || 'Model');
}

/**
 * A model id from its name: lowercase letters, digits and "-", at most 48 characters, unique among
 * `takenIds` (compared case-insensitively) by appending "-2", "-3", ... Always matches the id rule of scene.json.
 */
export function slugId(name: string, takenIds: Iterable<string>): string {
	const taken = new Set([...takenIds].map((id) => id.toLowerCase()));
	const base =
		name
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48)
			.replace(/-+$/g, '') || 'model';
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const id = `${base}-${n}`;
		if (!taken.has(id)) return id;
	}
}

/**
 * Default scale that makes the model's largest side about one metre, rounded to two significant digits and
 * kept inside the scale limits. `size` is the bounding box size in the model's own units.
 */
export function suggestedScale(size: readonly [number, number, number]): number {
	const largest = Math.max(...size);
	if (!Number.isFinite(largest) || largest <= 0) return 1;
	const scale = Number((1 / largest).toPrecision(2));
	return Math.min(LIMITS.maxScale, Math.max(LIMITS.minScale, scale));
}

/** What a picked set of files means: one model, or an error text. */
export function chooseModelFile(names: readonly string[]): { main: string; kind: 'glb' | 'gltf' } | { error: string } {
	const glbs = names.filter((name) => /\.glb$/i.test(name));
	const gltfs = names.filter((name) => /\.gltf$/i.test(name));
	if (glbs.length + gltfs.length === 0) return { error: 'Pick a .glb file, or a .gltf file together with its .bin and texture files.' };
	if (glbs.length + gltfs.length > 1) return { error: 'Pick one model at a time (one .glb, or one .gltf with its files).' };
	if (glbs.length === 1) return names.length > 1 ? { error: 'A .glb is one file. Pick only the .glb.' } : { main: glbs[0], kind: 'glb' };
	return { main: gltfs[0], kind: 'gltf' };
}

// --- Extensions ---------------------------------------------------------------------------------------

// Required extensions three's GLTFLoader (without Draco/KTX2/Meshopt decoders, which the admin does not set up) can read.
const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
	'KHR_materials_clearcoat',
	'KHR_materials_dispersion',
	'KHR_materials_ior',
	'KHR_materials_sheen',
	'KHR_materials_specular',
	'KHR_materials_transmission',
	'KHR_materials_iridescence',
	'KHR_materials_anisotropy',
	'KHR_materials_unlit',
	'KHR_materials_volume',
	'KHR_materials_emissive_strength',
	'KHR_texture_transform',
	'KHR_mesh_quantization',
	'KHR_lights_punctual',
	'EXT_materials_bump',
	'EXT_texture_webp',
	'EXT_texture_avif',
	'EXT_mesh_gpu_instancing',
]);

const COMPRESSION_EXTENSIONS: Readonly<Record<string, string>> = {
	KHR_draco_mesh_compression: 'Draco-compressed',
	EXT_meshopt_compression: 'Meshopt-compressed',
	KHR_meshopt_compression: 'Meshopt-compressed',
	KHR_texture_basisu: 'KTX2/Basis-compressed',
};

function checkAsset(json: Json) {
	const version = isRecord(json.asset) ? json.asset.version : undefined;
	if (typeof version !== 'string' || !/^2(\.|$)/.test(version)) fail('Not a glTF 2.0 model (asset.version is not 2.x).');
}

function checkExtensions(json: Json) {
	for (const name of asArray(json.extensionsRequired)) {
		if (typeof name !== 'string') continue;
		const kind = COMPRESSION_EXTENSIONS[name];
		if (kind) fail(`This model is ${kind} (${name}), which the editor cannot read. Export it again without compression.`);
		if (!SUPPORTED_EXTENSIONS.has(name)) fail(`This model requires the glTF extension ${name}, which is not supported.`);
	}
}

// --- GLB ----------------------------------------------------------------------------------------------

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export interface GlbInfo {
	/** The parsed JSON chunk. */
	json: Record<string, unknown>;
	/** The BIN chunk, or null when there is none. */
	bin: Uint8Array | null;
}

export function assertWithinCap(byteLength: number) {
	if (byteLength > MAX_MODEL_BYTES) fail(`The model is ${formatMb(byteLength)}; the limit is ${formatMb(MAX_MODEL_BYTES)}.`);
}

/** The reason an `uri` cannot be stored in a single GLB, or null when there is none. */
function uriProblem(uri: unknown, what: string): string | null {
	if (uri === undefined) return null;
	const text = typeof uri === 'string' ? uri : '';
	if (/^https?:/i.test(text)) return `${what} is loaded from the internet (${text.slice(0, 60)}). Only self-contained models are accepted.`;
	if (/^data:/i.test(text)) return `${what} is embedded as a data: URI. Export a binary .glb instead.`;
	return `${what} points to an external file. Export a self-contained .glb instead.`;
}

/**
 * Checks that `bytes` is a usable, self-contained binary glTF 2.0 and returns its JSON and BIN chunks.
 * Throws a ModelFileError with a sentence for the user otherwise.
 */
export function validateGlb(bytes: Uint8Array): GlbInfo {
	assertWithinCap(bytes.byteLength);
	if (bytes.byteLength < 20) fail('This file is too small to be a .glb model.');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== MAGIC) fail('This is not a .glb file (missing "glTF" header).');
	if (view.getUint32(4, true) !== 2) fail('Only glTF 2.0 models are supported (the file has another version).');
	if (view.getUint32(8, true) !== bytes.byteLength) fail('The .glb is damaged: its stored length does not match its size.');

	let json: Json | null = null;
	let bin: Uint8Array | null = null;
	let offset = 12;
	while (offset < bytes.byteLength) {
		if (offset + 8 > bytes.byteLength) fail('The .glb is damaged (truncated chunk header).');
		const length = view.getUint32(offset, true);
		const type = view.getUint32(offset + 4, true);
		const start = offset + 8;
		if (start + length > bytes.byteLength) fail('The .glb is damaged (a chunk runs past the end of the file).');
		if (offset === 12) {
			if (type !== CHUNK_JSON) fail('The .glb is damaged (the first chunk is not JSON).');
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + length)));
			} catch {
				fail('The .glb is damaged (its JSON chunk cannot be read).');
			}
			if (!isRecord(parsed)) fail('The .glb is damaged (its JSON chunk is not an object).');
			json = parsed as Json;
		} else if (type === CHUNK_BIN && !bin) {
			bin = bytes.subarray(start, start + length);
		}
		offset = start + length;
	}
	if (!json) fail('The .glb is damaged (no JSON chunk).');
	const doc = json as Json;
	checkAsset(doc);
	checkExtensions(doc);
	asArray(doc.buffers).forEach((buffer, index) => {
		const problem = isRecord(buffer) ? uriProblem(buffer.uri, `Buffer ${index}`) : null;
		if (problem) fail(problem);
	});
	asArray(doc.images).forEach((image, index) => {
		const problem = isRecord(image) ? uriProblem(image.uri, `Image ${index}`) : null;
		if (problem) fail(problem);
	});
	return { json: doc, bin };
}

// --- .gltf -> GLB -------------------------------------------------------------------------------------

const align4 = (n: number) => (n + 3) & ~3;

function decodeDataUri(uri: string): { bytes: Uint8Array; mime: string } {
	const match = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/is.exec(uri);
	if (!match) return fail('A data: URI in the .gltf is malformed.');
	const [, mime, params, payload] = match as unknown as [string, string, string, string];
	if (!/;base64/i.test(params)) return fail('A data: URI in the .gltf is not base64, which glTF requires.');
	try {
		const binary = atob(payload.replace(/\s+/g, ''));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return { bytes, mime };
	} catch {
		return fail('A data: URI in the .gltf cannot be decoded.');
	}
}

/** The picked file for a relative `uri` (exact name, then base name), or an error naming it. */
function findFile(uri: string, files: ReadonlyMap<string, Uint8Array>, what: string): Uint8Array {
	let name = uri;
	try {
		name = decodeURIComponent(uri);
	} catch {
		// keep the raw text
	}
	name = name.replace(/^\.\//, '');
	const base = name.replace(/^.*\//, '');
	const found = files.get(name) ?? files.get(base);
	if (!found) fail(`${what} needs the file "${base}", which was not picked. Select it together with the .gltf.`);
	return found as Uint8Array;
}

function sniffImageMime(bytes: Uint8Array): string | null {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) return 'image/webp';
	return null;
}

/**
 * Packs a parsed `.gltf` document into one GLB. Buffers are `data:` URIs or picked files (`files`, by name);
 * images become buffer views of the single BIN chunk. Throws a ModelFileError naming a missing file.
 */
export function packGltf(gltf: unknown, files: ReadonlyMap<string, Uint8Array>): Uint8Array {
	if (!isRecord(gltf)) return fail('The .gltf file is not a glTF document.');
	// Work on a copy: the caller's object stays untouched.
	const json = JSON.parse(JSON.stringify(gltf)) as Json;
	checkAsset(json);
	checkExtensions(json);

	const segments: { offset: number; bytes: Uint8Array }[] = [];
	let total = 0;
	const append = (bytes: Uint8Array): number => {
		const offset = align4(total);
		segments.push({ offset, bytes });
		total = offset + bytes.byteLength;
		return offset;
	};

	// Buffers: every one is appended; views are re-pointed to buffer 0 at the buffer's new offset.
	const bufferOffsets: number[] = [];
	asArray(json.buffers).forEach((buffer, index) => {
		if (!isRecord(buffer)) return fail(`Buffer ${index} of the .gltf is invalid.`);
		const uri = buffer.uri;
		if (typeof uri !== 'string') return fail(`Buffer ${index} of the .gltf has no data.`);
		let bytes: Uint8Array;
		if (/^data:/i.test(uri)) bytes = decodeDataUri(uri).bytes;
		else if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//')) return fail(uriProblem(uri, `Buffer ${index}`) as string);
		else bytes = findFile(uri, files, `Buffer ${index}`);
		const declared = buffer.byteLength === undefined ? bytes.byteLength : buffer.byteLength;
		if (typeof declared !== 'number' || !Number.isInteger(declared) || declared <= 0) fail(`Buffer ${index} has an invalid length.`);
		if (bytes.byteLength < declared) fail(`Buffer ${index} is shorter than the .gltf says (a wrong or truncated .bin?).`);
		bufferOffsets.push(append(bytes.subarray(0, declared)));
	});
	const views = asArray(json.bufferViews);
	for (const view of views) {
		if (!isRecord(view)) return fail('A buffer view of the .gltf is invalid.');
		const buffer = typeof view.buffer === 'number' ? view.buffer : -1;
		const base = bufferOffsets[buffer];
		if (base === undefined) return fail('A buffer view of the .gltf points to a missing buffer.');
		view.buffer = 0;
		view.byteOffset = base + (typeof view.byteOffset === 'number' ? view.byteOffset : 0);
	}

	// Images: files and data: URIs move into the BIN chunk as buffer views.
	asArray(json.images).forEach((image, index) => {
		if (!isRecord(image)) return fail(`Image ${index} of the .gltf is invalid.`);
		const uri = image.uri;
		if (uri === undefined) return; // already a buffer view
		if (typeof uri !== 'string') return fail(`Image ${index} of the .gltf is invalid.`);
		let bytes: Uint8Array;
		if (/^data:/i.test(uri)) {
			bytes = decodeDataUri(uri).bytes;
		} else if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//')) {
			return fail(uriProblem(uri, `Image ${index}`) as string);
		} else {
			bytes = findFile(uri, files, `Image ${index}`);
		}
		// Decided by the bytes, not by the declared type: only PNG, JPEG and WebP are accepted.
		const mime = sniffImageMime(bytes);
		if (!mime) return fail(`Image ${index} of the .gltf is not a PNG, JPEG or WebP picture.`);
		const offset = append(bytes);
		views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
		delete image.uri;
		image.mimeType = mime;
		image.bufferView = views.length - 1;
	});
	if (views.length > 0) json.bufferViews = views;

	if (segments.length > 0) json.buffers = [{ byteLength: total }];
	else delete json.buffers;

	return writeGlb(json, segments.length > 0 ? segments : null, total);
}

function writeGlb(json: Json, segments: { offset: number; bytes: Uint8Array }[] | null, binLength: number): Uint8Array {
	const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
	const jsonPadded = align4(jsonBytes.byteLength);
	const binPadded = segments ? align4(binLength) : 0;
	const length = 12 + 8 + jsonPadded + (segments ? 8 + binPadded : 0);
	assertWithinCap(length);
	const out = new Uint8Array(length);
	const view = new DataView(out.buffer);
	view.setUint32(0, MAGIC, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, length, true);
	view.setUint32(12, jsonPadded, true);
	view.setUint32(16, CHUNK_JSON, true);
	out.set(jsonBytes, 20);
	out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonPadded); // JSON is padded with spaces
	if (segments) {
		const binStart = 20 + jsonPadded;
		view.setUint32(binStart, binPadded, true);
		view.setUint32(binStart + 4, CHUNK_BIN, true);
		for (const { offset, bytes } of segments) out.set(bytes, binStart + 8 + offset);
	}
	return out;
}
