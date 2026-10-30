// Writes public/models/test-crate.glb: a 0.8-unit wooden box as a minimal glTF 2.0 binary.
// No dependencies. Run it from the repository root: node scripts/make-test-model.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const out = new URL('../public/models/test-crate.glb', import.meta.url);
const h = 0.4; // half size

// 24 vertices (4 per face) so every face gets its own flat normal.
const faces = [
	// normal, then the four corners counter-clockwise seen from outside
	[[1, 0, 0], [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]]],
	[[-1, 0, 0], [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]]],
	[[0, 1, 0], [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]]],
	[[0, -1, 0], [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]]],
	[[0, 0, 1], [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]]],
	[[0, 0, -1], [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]]],
];
const positions = [];
const normals = [];
const indices = [];
faces.forEach(([normal, corners], f) => {
	for (const corner of corners) {
		positions.push(...corner);
		normals.push(...normal);
	}
	const o = f * 4;
	indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
});

const posBytes = Buffer.from(new Float32Array(positions).buffer);
const nrmBytes = Buffer.from(new Float32Array(normals).buffer);
const idxBytes = Buffer.from(new Uint16Array(indices).buffer);
const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const bin = Buffer.concat([pad4(posBytes), pad4(nrmBytes), pad4(idxBytes)]);

const json = {
	asset: { version: '2.0', generator: 'scripts/make-test-model.mjs' },
	scene: 0,
	scenes: [{ nodes: [0] }],
	nodes: [{ mesh: 0, name: 'test-crate' }],
	meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
	materials: [
		{
			name: 'crate-wood',
			pbrMetallicRoughness: { baseColorFactor: [0.78, 0.58, 0.36, 1], metallicFactor: 0, roughnessFactor: 0.9 },
		},
	],
	accessors: [
		{ bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-h, -h, -h], max: [h, h, h] },
		{ bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
		{ bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
	],
	bufferViews: [
		{ buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
		{ buffer: 0, byteOffset: pad4(posBytes).length, byteLength: nrmBytes.length, target: 34962 },
		{ buffer: 0, byteOffset: pad4(posBytes).length + pad4(nrmBytes).length, byteLength: idxBytes.length, target: 34963 },
	],
	buffers: [{ byteLength: bin.length }],
};

// JSON chunk is padded with spaces, BIN chunk with zeros (glTF 2.0 spec, section 4.4).
let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // "glTF"
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
const chunkHeader = (length, type) => {
	const b = Buffer.alloc(8);
	b.writeUInt32LE(length, 0);
	b.writeUInt32LE(type, 4);
	return b;
};
const glb = Buffer.concat([
	header,
	chunkHeader(jsonBytes.length, 0x4e4f534a), // "JSON"
	jsonBytes,
	chunkHeader(bin.length, 0x004e4942), // "BIN\0"
	bin,
]);

mkdirSync(dirname(out.pathname), { recursive: true });
writeFileSync(out, glb);
console.log(`wrote ${out.pathname} (${glb.length} bytes)`);
