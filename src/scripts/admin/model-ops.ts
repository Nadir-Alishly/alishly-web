// The model library's pending changes and how "Save models" turns them into ONE commit. Pure TypeScript
// with only erasable syntax and no DOM/three/Astro imports; the GitHub client is injected, so Node tests
// drive it with a fake. Nothing here trusts the page's copy of models.json: the pending operations are
// merged into the version at the branch head, which is read right before committing.
import { modelIdOf, parseModels, parseScene } from '../../data/scene.ts';
import type { ModelEntry, SceneData } from '../../data/scene.ts';
import { GithubError } from './github.ts';
import type { FileChange, GithubClient } from './github.ts';
import { modelFileUrl, modelRepoPath } from './model-file.ts';

export const MODELS_JSON_PATH = 'src/data/models.json';

/** A model imported on this page and not committed yet. */
export interface PendingImport {
	entry: ModelEntry;
	/** The complete .glb that will be committed. */
	bytes: Uint8Array;
}

export interface PendingModels {
	added: readonly PendingImport[];
	/** Ids of saved models to delete. */
	removed: readonly string[];
}

/** How many objects of each model `scene` has, per room slug. Rooms without any are left out. */
export function modelUsage(scene: SceneData, modelId: string): { slug: string; count: number }[] {
	const out: { slug: string; count: number }[] = [];
	for (const [slug, room] of Object.entries(scene.rooms)) {
		const count = room.objects.filter((object) => modelIdOf(object.type) === modelId).length;
		if (count > 0) out.push({ slug, count });
	}
	return out;
}

/** "bedroom: 2, kitchen: 1" (rooms by `names`, falling back to the slug). */
export function describeUsage(usage: readonly { slug: string; count: number }[], names: ReadonlyMap<string, string> = new Map()): string {
	return usage.map(({ slug, count }) => `${names.get(slug) ?? slug}: ${count}`).join(', ');
}

/** The entry as stored in models.json: fixed key order and a path derived from the id. */
export function canonicalEntry(id: string, label: string, defaultScale: number): ModelEntry {
	return { id, label, file: modelFileUrl(id), defaultScale };
}

/** The git blob sha (what GitHub calls a file's sha) of `bytes`: SHA-1 over "blob <length>\0" + bytes. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const data = new Uint8Array(header.byteLength + bytes.byteLength);
	data.set(header);
	data.set(bytes, header.byteLength);
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', data));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const serializeModels = (entries: readonly ModelEntry[]) => `${JSON.stringify(entries, null, '\t')}\n`;

export function commitMessage(added: number, removed: number): string {
	const parts = [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean);
	return `admin: update model library (${parts.join(', ')})`;
}

export interface ModelCommit {
	message: string;
	/** Empty when GitHub already has everything: do not commit. */
	changes: FileChange[];
	modelsText: string;
	added: number;
	/** Entries actually removed from the remote list (a pending delete that is already gone remotely does not count). */
	removed: number;
}

/**
 * Merges `pending` into the remote models.json and lists the files to commit. Fails closed (GithubError)
 * when the remote models.json or scene.json cannot be read, when a deleted model is still used in the
 * remote scene, or when an imported id is already taken remotely.
 */
export function buildModelCommit(args: {
	remoteModelsText: string;
	remoteSceneText: string;
	slugs: readonly string[];
	pending: PendingModels;
	/** Room slug -> name for messages. */
	roomNames?: ReadonlyMap<string, string>;
	/** Ids of pending imports whose identical file is already on GitHub (see `findSavedImports`). */
	savedIds?: ReadonlySet<string>;
}): ModelCommit {
	const { pending } = args;

	let rawModels: unknown;
	try {
		rawModels = JSON.parse(args.remoteModelsText);
	} catch {
		throw new GithubError('bad-response', 'models.json on GitHub is not valid JSON, so the library was not saved.');
	}
	const remote = parseModels(rawModels);
	if (!Array.isArray(rawModels) || remote.length !== rawModels.length) {
		throw new GithubError(
			'bad-response',
			'models.json on GitHub has entries this page cannot read, so the library was not saved. Fix that file first.',
		);
	}

	let rawScene: unknown;
	try {
		rawScene = JSON.parse(args.remoteSceneText);
	} catch {
		throw new GithubError('bad-response', 'The scene file on GitHub is not valid JSON, so the library was not saved.');
	}
	const scene = parseScene(rawScene, { slugs: args.slugs });
	if (!scene.ok) {
		throw new GithubError('bad-response', `The scene file on GitHub cannot be read, so the library was not saved: ${scene.warnings[0]}`);
	}
	for (const id of pending.removed) {
		const usage = modelUsage(scene.scene, id);
		if (usage.length > 0) {
			const label = remote.find((entry) => entry.id === id)?.label ?? id;
			throw new GithubError(
				'rejected',
				`"${label}" cannot be deleted: the scene on GitHub still uses it (${describeUsage(usage, args.roomNames)}). Remove those objects and save the scene first.`,
			);
		}
	}

	const importIds = pending.added.map(({ entry }) => entry.id.toLowerCase());
	if (new Set(importIds).size !== importIds.length) {
		throw new GithubError('rejected', 'Two pending imports have the same id. Discard one of them and import it again under another name.');
	}

	const changes: FileChange[] = [];
	const removedIds = new Set(pending.removed);
	// Paths this commit writes; a delete of the same path (delete + import under one id) is dropped.
	const written = new Set(pending.added.map(({ entry }) => entry.id));
	let removedCount = 0;
	let addedCount = 0;
	const next: ModelEntry[] = [];
	for (const entry of remote) {
		if (!removedIds.has(entry.id)) {
			next.push(entry);
			continue;
		}
		removedCount++;
		// Only the file this page would have written is deleted; a hand-made entry may point elsewhere.
		if (entry.file === modelFileUrl(entry.id) && !written.has(entry.id)) changes.push({ path: modelRepoPath(entry.id), delete: true });
	}
	for (const { entry, bytes } of pending.added) {
		const canonical = canonicalEntry(entry.id, entry.label, entry.defaultScale);
		const clash = next.find((other) => other.id.toLowerCase() === entry.id.toLowerCase());
		if (clash) {
			// An identical entry AND file is what an earlier attempt left behind when its answer got lost: already saved.
			const sameEntry = JSON.stringify(clash) === JSON.stringify(canonical);
			if (sameEntry && args.savedIds?.has(entry.id)) continue;
			throw new GithubError(
				'rejected',
				sameEntry
					? `The entry "${entry.id}" already exists on GitHub, but its file there is missing or not the same as this import. Remove the pending import and import it again under another name.`
					: `A different model with the id "${entry.id}" now exists on GitHub. Remove the pending import and import it again under another name.`,
			);
		}
		next.push(canonical);
		changes.push({ path: modelRepoPath(entry.id), bytes });
		addedCount++;
	}
	if (addedCount === 0 && removedCount === 0) return { message: '', changes: [], modelsText: args.remoteModelsText, added: 0, removed: 0 };
	const modelsText = serializeModels(next);
	changes.push({ path: MODELS_JSON_PATH, text: modelsText });
	return { message: commitMessage(addedCount, removedCount), changes, modelsText, added: addedCount, removed: removedCount };
}

/**
 * Ids of pending imports that are already on GitHub at `head`: the remote models.json has the identical entry
 * and the file there is byte-identical (same git blob sha). Anything unreadable simply means "not saved".
 */
export async function findSavedImports(
	github: Pick<GithubClient, 'getBlobSha'>,
	remoteModelsText: string,
	added: readonly PendingImport[],
	head: string,
): Promise<Set<string>> {
	const saved = new Set<string>();
	let remote: ModelEntry[];
	try {
		remote = parseModels(JSON.parse(remoteModelsText));
	} catch {
		return saved;
	}
	for (const { entry, bytes } of added) {
		const canonical = JSON.stringify(canonicalEntry(entry.id, entry.label, entry.defaultScale));
		if (!remote.some((other) => JSON.stringify(other) === canonical)) continue;
		const remoteSha = await github.getBlobSha(modelRepoPath(entry.id), head);
		if (remoteSha !== null && remoteSha === (await gitBlobSha(bytes))) saved.add(entry.id);
	}
	return saved;
}

export interface SaveModelsResult {
	/** Null when GitHub already had everything (nothing was committed). */
	commitSha: string | null;
	added: number;
	removed: number;
}

/**
 * Reads models.json and the scene at the branch head, merges `pending`, and commits everything at once.
 * When the branch moved meanwhile (`conflict`) it starts over once from the new head.
 */
export async function saveModels(args: {
	github: Pick<GithubClient, 'getHead' | 'getFileAt' | 'getBlobSha' | 'commitFiles'>;
	/** Repository path of scene.json. */
	scenePath: string;
	slugs: readonly string[];
	pending: PendingModels;
	roomNames?: ReadonlyMap<string, string>;
}): Promise<SaveModelsResult> {
	const { github, scenePath, slugs, pending, roomNames } = args;
	for (let attempt = 0; ; attempt++) {
		try {
			const head = await github.getHead();
			const models = await github.getFileAt(MODELS_JSON_PATH, head);
			const scene = await github.getFileAt(scenePath, head);
			const savedIds = await findSavedImports(github, models.text, pending.added, head);
			const commit = buildModelCommit({ remoteModelsText: models.text, remoteSceneText: scene.text, slugs, pending, roomNames, savedIds });
			if (commit.changes.length === 0) return { commitSha: null, added: 0, removed: 0 };
			const { commitSha } = await github.commitFiles({ message: commit.message, changes: commit.changes, expectedHead: head });
			return { commitSha, added: commit.added, removed: commit.removed };
		} catch (error) {
			if (attempt === 0 && error instanceof GithubError && error.kind === 'conflict') continue;
			throw error;
		}
	}
}
