// Shared helpers for the local-save tests (task local-folder): a fake repository root whose DEV data lives in
// local/ (local/scene.json, local/models.json, local/models/<id>.glb) next to "committed" canary files
// (src/data/*.json, public/models/*.glb) that must never be touched by the dev endpoint.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emptyScene, serializeScene } from '../../src/data/scene.ts';
import { makeBoxGlb } from './gltf-fixtures.ts';

export const SLUGS = ['elnur', 'sabina', 'nadir', 'chinara', 'alibala', 'elkhan', 'fazil'];

/** Wire path (what the admin client sends) -> path on disk relative to the repo root. */
export function toDisk(rel: string): string {
	if (rel === 'src/data/scene.json') return 'local/scene.json';
	if (rel === 'src/data/models.json') return 'local/models.json';
	const m = /^public\/models\/(.+\.glb)$/.exec(rel);
	if (m) return `local/models/${m[1]}`;
	return rel;
}

/** A scene with one object in elnur's room (type default 'box'). */
export function sceneWithObject(id: string, type = 'box', slugs: readonly string[] = SLUGS): string {
	const scene = emptyScene(slugs);
	scene.rooms.elnur.objects = [{ id, type, position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] }] as never;
	return serializeScene(scene);
}

export const modelsJsonText = (...ids: string[]): string =>
	`${JSON.stringify(ids.map((id) => ({ id, label: id, file: `/models/${id}.glb`, defaultScale: 1 })), null, '\t')}\n`;

/** The committed canaries. Deliberately different from anything a test writes to local/. */
export const COMMITTED_SCENE = sceneWithObject('COMMITTED_CANARY', 'box');
export const COMMITTED_MODELS = modelsJsonText('committed-canary');
export const COMMITTED_GLB = Buffer.from(makeBoxGlb());

export interface SeedOptions {
	/** Content of local/scene.json (default: an empty scene). `false`: do not create the file. */
	scene?: string | false;
	/** Content of local/models.json (default: `[]\n`). `false`: do not create the file. */
	models?: string | false;
	/** ids written to local/models/<id>.glb (the box fixture). */
	glbs?: string[];
	/** Create local/ and local/models at all (default true). */
	local?: boolean;
	/** Create the committed canaries src/data/*.json + public/models/committed-canary.glb (default true). */
	committed?: boolean;
}

/** Creates `root` with a local/ data folder and committed canaries. Returns the snapshot taker for the canaries. */
export async function seedRepo(root: string, opts: SeedOptions = {}) {
	const { scene, models, glbs = [], local = true, committed = true } = opts;
	await mkdir(root, { recursive: true });
	if (committed) {
		await mkdir(path.join(root, 'src/data'), { recursive: true });
		await mkdir(path.join(root, 'public/models'), { recursive: true });
		await writeFile(path.join(root, 'src/data/scene.json'), COMMITTED_SCENE);
		await writeFile(path.join(root, 'src/data/models.json'), COMMITTED_MODELS);
		await writeFile(path.join(root, 'public/models/committed-canary.glb'), COMMITTED_GLB);
	}
	if (local) {
		await mkdir(path.join(root, 'local/models'), { recursive: true });
		if (scene !== false) await writeFile(path.join(root, 'local/scene.json'), scene ?? serializeScene(emptyScene(SLUGS)));
		if (models !== false) await writeFile(path.join(root, 'local/models.json'), models ?? '[]\n');
		for (const id of glbs) await writeFile(path.join(root, `local/models/${id}.glb`), makeBoxGlb());
	}
	return { snapshot: () => snapshotCommitted(root) };
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** sha256 of every file under src/data and public/models of `root` (name -> hash), so a test can prove nothing changed. */
export async function snapshotCommitted(root: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const dir of ['src/data', 'public/models']) {
		let entries: string[] = [];
		try {
			entries = await readdir(path.join(root, dir));
		} catch {
			continue;
		}
		for (const name of entries.sort()) out[`${dir}/${name}`] = sha256(await readFile(path.join(root, dir, name)));
	}
	return out;
}

/** Lists the names under local/ and local/models (sorted), for "nothing else was created" assertions. */
export async function listLocal(root: string): Promise<{ top: string[]; models: string[] }> {
	const top = (await readdir(path.join(root, 'local')).catch(() => [])).sort();
	const models = (await readdir(path.join(root, 'local/models')).catch(() => [])).sort();
	return { top, models };
}
