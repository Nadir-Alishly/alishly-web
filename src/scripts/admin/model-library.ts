// The "Model library" panel of /admin: import a .glb (or a .gltf with its files), list the models, delete
// them, and "Save models" (one commit). Imports and deletes are staged here until then. Everything that
// comes from files or GitHub goes through textContent only.
import { LIMITS, modelIdOf } from '../../data/scene';
import type { ModelEntry, SceneData } from '../../data/scene';
import { getCatalog } from '../room-objects';
import type { CatalogEntry } from '../room-objects';
import { inspectModel, registerModel, unregisterModel } from './model-registry';
import { GithubError, describeError } from './github';
import type { GithubClient } from './github';
import {
	MAX_MODEL_BYTES,
	ModelFileError,
	assertWithinCap,
	chooseModelFile,
	clipLabel,
	labelFromFilename,
	packGltf,
	slugId,
	suggestedScale,
	validateGlb,
} from './model-file';
import { GITHUB_WORDING } from './backend';
import type { Wording } from './backend';
import { canonicalEntry, describeUsage, modelUsage, saveModels } from './model-ops';
import type { PendingImport } from './model-ops';

const CONFIRM_MS = 5000;
/** Upper bound for everything read from disk at once (a .gltf with its textures), before packing. */
const MAX_PICKED_BYTES = 4 * MAX_MODEL_BYTES;

export interface ModelLibraryOptions {
	root: HTMLElement;
	/** Room slug -> name shown in messages. */
	roomNames: ReadonlyMap<string, string>;
	slugs: readonly string[];
	getScene(): SceneData;
	/** Runs `action` exclusively with the scene's own Save (shared busy lock); `onError` shows a failure. */
	run(action: () => Promise<void>, onError: (error: unknown) => void): Promise<void>;
	isBusy(): boolean;
	client(): GithubClient;
	/** Repository path of scene.json. */
	scenePath(): string;
	/** The set of models changed (palette needs a rebuild). */
	onCatalogChange(): void;
	/** Where the models are saved, for messages; read at use time. Defaults to the GitHub wording. */
	wording?(): Wording;
}

export interface ModelLibrary {
	/** Re-evaluates which controls are enabled (call when the busy state changes). */
	refresh(): void;
	hasPending(): boolean;
	/** Add-to-room entries: all models except those queued for deletion. */
	catalog(): CatalogEntry[];
	/** Labels of imported-but-unsaved models that `scene` already uses. */
	pendingUsedBy(scene: SceneData): string[];
	/** Tells the user when the scene (e.g. after "Load latest") uses a model that is queued for deletion. */
	checkRemovals(): void;
}

const byId = <T extends HTMLElement>(root: HTMLElement, id: string): T => {
	const element = root.querySelector<T>(`#${id}`);
	if (!element) throw new Error(`Admin page is missing #${id}`);
	return element;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
	bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? (bytes.buffer as ArrayBuffer)
		: (bytes.slice().buffer as ArrayBuffer);

export function mountModelLibrary(options: ModelLibraryOptions): ModelLibrary {
	const { root } = options;
	const wording = () => options.wording?.() ?? GITHUB_WORDING;
	const fileInput = byId<HTMLInputElement>(root, 'lib-file');
	const form = byId(root, 'lib-form');
	const formInfo = byId(root, 'lib-form-info');
	const nameInput = byId<HTMLInputElement>(root, 'lib-name');
	const scaleInput = byId<HTMLInputElement>(root, 'lib-scale');
	const addButton = byId<HTMLButtonElement>(root, 'lib-add');
	const cancelButton = byId<HTMLButtonElement>(root, 'lib-cancel');
	const list = byId(root, 'lib-list');
	const empty = byId(root, 'lib-empty');
	const saveButton = byId<HTMLButtonElement>(root, 'lib-save');
	const status = byId(root, 'lib-status');

	const pendingImports = new Map<string, PendingImport>();
	const pendingRemovals = new Set<string>();
	/** A picked model that passed all checks and waits for its name and scale. */
	let draft: { bytes: Uint8Array; size: [number, number, number]; filename: string } | null = null;
	let reading = false;
	let confirming: { id: string; timer: number } | null = null;

	const setStatus = (text: string, kind: 'info' | 'success' | 'error' = 'info') => {
		status.textContent = text;
		status.dataset.kind = kind;
	};

	const models = () =>
		getCatalog()
			.filter((entry) => entry.kind === 'model')
			.map((entry) => ({ id: modelIdOf(entry.type) as string, entry }));

	const pendingCount = () => pendingImports.size + pendingRemovals.size;
	const roomsText = (usage: { slug: string; count: number }[]) => describeUsage(usage, options.roomNames);

	function refresh() {
		const busy = options.isBusy();
		fileInput.disabled = busy || reading;
		addButton.disabled = busy;
		cancelButton.disabled = busy;
		nameInput.disabled = busy;
		scaleInput.disabled = busy;
		for (const button of list.querySelectorAll('button')) button.disabled = busy;
		saveButton.disabled = busy || pendingCount() === 0;
		saveButton.textContent = pendingCount() > 0 ? `Save models (${pendingCount()})` : 'Save models';
		saveButton.setAttribute('aria-busy', String(busy));
	}

	function cancelConfirm() {
		if (confirming) window.clearTimeout(confirming.timer);
		confirming = null;
	}

	/** Why `id` cannot be removed right now, or null. */
	function usedMessage(id: string, label: string): string | null {
		const usage = modelUsage(options.getScene(), id);
		return usage.length === 0 ? null : `"${label}" is used in the scene (${roomsText(usage)}). Remove those objects first.`;
	}

	function remove(id: string) {
		const entry = models().find((model) => model.id === id)?.entry;
		if (!entry) return;
		const problem = usedMessage(id, entry.label);
		if (problem) {
			setStatus(problem, 'error');
			render(); // disarms the confirm button
			return;
		}
		if (pendingImports.has(id)) {
			pendingImports.delete(id);
			unregisterModel(id); // never saved: free it now
			setStatus(`Discarded "${entry.label}".`);
		} else {
			pendingRemovals.add(id);
			setStatus(`"${entry.label}" will be deleted when you click Save models.`);
		}
		render();
		options.onCatalogChange();
	}

	function render() {
		cancelConfirm();
		// The list is rebuilt: keep keyboard focus on the same row (or the last one) instead of losing it to <body>.
		const focused = document.activeElement;
		const row = focused && list.contains(focused) ? [...list.children].indexOf(focused.closest('li') as Element) : -1;
		const rows = models();
		empty.hidden = rows.length > 0;
		list.replaceChildren(
			...rows.map(({ id, entry }) => {
				const item = document.createElement('li');
				item.className = 'flex items-center gap-2 text-sm';
				const name = document.createElement('span');
				name.className = 'min-w-0 flex-1 truncate';
				name.textContent = entry.label;
				name.title = `${entry.label} (${id})`;
				item.append(name);

				const removing = pendingRemovals.has(id);
				const isNew = pendingImports.has(id);
				if (removing || isNew) {
					const badge = document.createElement('span');
					badge.className = `rounded-full px-2 py-0.5 text-xs ${removing ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`;
					badge.textContent = removing ? 'To delete' : 'New';
					item.append(badge);
				}

				const button = document.createElement('button');
				button.type = 'button';
				button.className =
					'rounded-full px-2.5 py-1 text-xs font-medium outline-offset-2 focus-visible:outline-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:opacity-40 ' +
					(removing ? 'text-stone-700 ring-1 ring-stone-300 hover:bg-stone-100' : 'text-red-700 ring-1 ring-red-200 hover:bg-red-50');
				const idle = removing ? 'Undo' : isNew ? 'Discard' : 'Delete';
				button.textContent = idle;
				button.setAttribute('aria-label', `${idle} ${entry.label}`);
				const disarm = () => {
					button.textContent = idle;
					button.setAttribute('aria-label', `${idle} ${entry.label}`);
				};
				button.addEventListener('click', () => {
					if (removing) {
						pendingRemovals.delete(id);
						setStatus(`Kept "${entry.label}".`);
						render();
						options.onCatalogChange();
						return;
					}
					// Two clicks: the first arms the button for a few seconds.
					if (confirming?.id === id) {
						cancelConfirm();
						remove(id);
						return;
					}
					cancelConfirm();
					button.textContent = `${idle}? Click again`;
					button.setAttribute('aria-label', `${idle} ${entry.label}: click again to confirm`);
					confirming = {
						id,
						timer: window.setTimeout(() => {
							confirming = null;
							disarm();
						}, CONFIRM_MS),
					};
				});
				item.append(button);
				return item;
			}),
		);
		refresh();
		if (row >= 0) {
			const buttons = list.querySelectorAll('button');
			(buttons[Math.min(row, buttons.length - 1)] ?? (saveButton.disabled ? fileInput : saveButton)).focus();
		}
	}

	// --- Import -----------------------------------------------------------------------------------------
	const hideForm = () => {
		draft = null;
		form.hidden = true;
	};

	async function readPicked(files: File[]): Promise<{ bytes: Uint8Array; filename: string }> {
		const choice = chooseModelFile(files.map((file) => file.name));
		if ('error' in choice) throw new ModelFileError(choice.error);
		const main = files.find((file) => file.name === choice.main) as File;
		if (files.reduce((sum, file) => sum + file.size, 0) > MAX_PICKED_BYTES) {
			throw new ModelFileError('The picked files are too large.');
		}
		let bytes: Uint8Array;
		if (choice.kind === 'glb') {
			assertWithinCap(main.size); // before reading it into memory
			bytes = new Uint8Array(await main.arrayBuffer());
		} else {
			let json: unknown;
			try {
				json = JSON.parse(await main.text());
			} catch {
				throw new ModelFileError('The .gltf file is not valid JSON.');
			}
			const others = new Map<string, Uint8Array>();
			for (const file of files) if (file !== main) others.set(file.name, new Uint8Array(await file.arrayBuffer()));
			bytes = packGltf(json, others);
		}
		validateGlb(bytes);
		return { bytes, filename: main.name };
	}

	async function onPick() {
		const files = [...(fileInput.files ?? [])];
		fileInput.value = ''; // the same file can be picked again
		if (files.length === 0) return;
		hideForm();
		reading = true;
		refresh();
		setStatus('Reading the model…');
		try {
			const { bytes, filename } = await readPicked(files);
			let size: [number, number, number];
			try {
				size = (await inspectModel(toArrayBuffer(bytes))).size;
			} catch (error) {
				console.warn('Model could not be loaded.', error);
				throw new ModelFileError(
					`The model could not be loaded${error instanceof Error && error.message ? `: ${error.message.slice(0, 120)}` : '.'}`,
				);
			}
			draft = { bytes, size, filename };
			nameInput.value = labelFromFilename(filename);
			scaleInput.value = String(suggestedScale(size));
			formInfo.textContent = `Size ${size.map((n) => Number(n.toPrecision(3))).join(' × ')} (model units), ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB.`;
			form.hidden = false;
			setStatus('Check the name and scale, then click Add.');
		} catch (error) {
			if (!(error instanceof ModelFileError)) console.error(error);
			setStatus(error instanceof ModelFileError ? error.message : 'That file could not be read.', 'error');
		} finally {
			reading = false;
			refresh();
		}
	}
	fileInput.addEventListener('change', () => void onPick());

	function takenIds(): Set<string> {
		const taken = new Set(models().map((model) => model.id));
		// Ids that scene objects already refer to (objects of models not in the library): do not adopt them.
		for (const room of Object.values(options.getScene().rooms)) {
			for (const object of room.objects) {
				const id = modelIdOf(object.type);
				if (id !== null) taken.add(id);
			}
		}
		return taken;
	}

	function add() {
		if (!draft || options.isBusy()) return;
		const label = clipLabel(nameInput.value.trim());
		if (!label) {
			setStatus('Enter a name for the model.', 'error');
			nameInput.focus();
			return;
		}
		const scale = Number(scaleInput.value);
		if (scaleInput.value.trim() === '' || !(scale >= LIMITS.minScale && scale <= LIMITS.maxScale)) {
			setStatus(`The scale must be a number from ${LIMITS.minScale} to ${LIMITS.maxScale}.`, 'error');
			scaleInput.focus();
			return;
		}
		const entry: ModelEntry = canonicalEntry(slugId(label, takenIds()), label, Number(scale.toPrecision(4)));
		try {
			registerModel(entry, toArrayBuffer(draft.bytes));
		} catch (error) {
			console.error(error);
			setStatus('The model could not be added.', 'error');
			return;
		}
		pendingImports.set(entry.id, { entry, bytes: draft.bytes });
		hideForm();
		render();
		options.onCatalogChange();
		setStatus(wording().modelAdded(label), 'success');
	}
	addButton.addEventListener('click', add);
	cancelButton.addEventListener('click', () => {
		hideForm();
		setStatus('');
	});
	for (const input of [nameInput, scaleInput]) {
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				add();
			}
		});
	}

	// --- Save models ------------------------------------------------------------------------------------
	saveButton.addEventListener('click', () => {
		if (pendingCount() === 0) return;
		void options.run(
			async () => {
				for (const id of pendingRemovals) {
					const problem = usedMessage(id, models().find((model) => model.id === id)?.entry.label ?? id);
					if (problem) throw new GithubError('rejected', problem);
				}
				setStatus('Saving models…');
				const result = await saveModels({
					github: options.client(),
					scenePath: options.scenePath(),
					slugs: options.slugs,
					roomNames: options.roomNames,
					pending: { added: [...pendingImports.values()], removed: [...pendingRemovals] },
					where: wording().where,
				});
				// The committed models stay registered (read from memory until the page is reloaded after the rebuild).
				pendingImports.clear();
				for (const id of pendingRemovals) unregisterModel(id);
				pendingRemovals.clear();
				render();
				options.onCatalogChange();
				if (result.commitSha === null) {
					setStatus(wording().modelsUpToDate, 'success');
					return;
				}
				const parts = [
					result.added > 0 ? `${result.added} added` : '',
					result.removed > 0 ? `${result.removed} deleted` : '',
				].filter(Boolean);
				setStatus(wording().modelsSaved(parts.join(', ')), 'success');
			},
			(error) => {
				if (!(error instanceof GithubError)) console.error(error); // never carries the token
				setStatus(describeError(error), 'error');
			},
		);
	});

	render();
	return {
		refresh,
		hasPending: () => pendingCount() > 0,
		catalog: () => getCatalog().filter((entry) => !pendingRemovals.has(modelIdOf(entry.type) ?? '')),
		checkRemovals() {
			for (const id of pendingRemovals) {
				const label = models().find((model) => model.id === id)?.entry.label ?? id;
				const problem = usedMessage(id, label);
				if (problem) {
					setStatus(`${problem} It is queued for deletion: click Undo, or remove those objects.`, 'error');
					return;
				}
			}
		},
		pendingUsedBy(scene) {
			const names: string[] = [];
			for (const [id, { entry }] of pendingImports) {
				if (modelUsage(scene, id).length > 0) names.push(entry.label);
			}
			return names;
		},
	};
}
