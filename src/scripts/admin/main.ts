// Wires the /admin page: DOM controls <-> editor <-> GitHub client.
// Everything user-visible that comes from GitHub or from the token goes through textContent only.
import { LIMITS, parseScene, serializeScene, validateScene } from '../../data/scene';
import type { ParseOptions, SceneData, SceneObject, Vec3 } from '../../data/scene';
import { CATALOG, catalogEntry } from '../room-objects';
import { createEditor } from './editor';
import type { ChangeReason, Editor, RoomInfo, TransformMode } from './editor';
import {
	GithubError,
	createGithubClient,
	describeError,
	forgetToken,
	loadTarget,
	loadToken,
	saveTarget,
	saveToken,
	validateTarget,
} from './github';
import type { GithubTarget, StorageLike } from './github';
import { mountSettingsPanel } from './settings-panel';
import type { SettingsPanel } from './settings-panel';

const DEFAULT_MESSAGE = 'Update room scenes via admin';
const CONFIRM_MS = 5000;

const byId = <T extends HTMLElement>(id: string): T => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Admin page is missing #${id}`);
	return element as T;
};

/** Storage can throw (private windows, blocked cookies); a missing one just means "not remembered". */
function storage(kind: 'sessionStorage' | 'localStorage'): StorageLike | null {
	try {
		return window[kind];
	} catch {
		return null;
	}
}

export function mountAdmin(root: HTMLElement) {
	// A re-evaluated module (dev HMR) must not mount a second editor on the same canvas and page.
	const flag = window as typeof window & { __adminMounted?: boolean };
	if (flag.__adminMounted) return;
	flag.__adminMounted = true;

	const rooms = JSON.parse(root.dataset.rooms ?? '[]') as RoomInfo[];
	// No `modelIds` on purpose: objects of an unknown model are kept (and written back by Save), not dropped.
	const parseOptions: ParseOptions = { slugs: rooms.map((r) => r.slug) };
	const knownTypes = new Set(CATALOG.map((entry) => entry.type));
	const bundled = parseScene(JSON.parse(root.dataset.bundled ?? '{}'), parseOptions);

	const session = storage('sessionStorage');
	const local = storage('localStorage');

	// --- Elements -----------------------------------------------------------------------------
	const canvas = byId<HTMLCanvasElement>('admin-canvas');
	const roomSelect = byId<HTMLSelectElement>('room-select');
	const wallInput = byId<HTMLInputElement>('room-wall-color');
	const wallReset = byId<HTMLButtonElement>('room-wall-reset');
	const settingsBox = byId('settings-panel');
	const indicator = byId('unsaved-indicator');
	const indicatorText = byId('unsaved-text');
	const catalogBox = byId('catalog');
	const modeButtons: Record<TransformMode, HTMLButtonElement> = {
		translate: byId<HTMLButtonElement>('mode-translate'),
		rotate: byId<HTMLButtonElement>('mode-rotate'),
		scale: byId<HTMLButtonElement>('mode-scale'),
	};
	const optSnap = byId<HTMLInputElement>('opt-snap');
	const optBounds = byId<HTMLInputElement>('opt-bounds');
	const selectionEmpty = byId('selection-empty');
	const selectionPanel = byId('selection-panel');
	const selectionLabel = byId('selection-label');
	const colorInput = byId<HTMLInputElement>('sel-color');
	const colorReset = byId<HTMLButtonElement>('sel-color-reset');
	const duplicateButton = byId<HTMLButtonElement>('btn-duplicate');
	const deleteButton = byId<HTMLButtonElement>('btn-delete');
	const numberFields = [...root.querySelectorAll<HTMLInputElement>('input[data-field]')];
	const targetInputs: Record<keyof GithubTarget, HTMLInputElement> = {
		owner: byId<HTMLInputElement>('gh-owner'),
		repo: byId<HTMLInputElement>('gh-repo'),
		branch: byId<HTMLInputElement>('gh-branch'),
		path: byId<HTMLInputElement>('gh-path'),
	};
	const tokenInput = byId<HTMLInputElement>('gh-token');
	const rememberInput = byId<HTMLInputElement>('gh-remember');
	const forgetButton = byId<HTMLButtonElement>('gh-forget');
	const loadButton = byId<HTMLButtonElement>('gh-load');
	const messageInput = byId<HTMLInputElement>('gh-message');
	const saveButton = byId<HTMLButtonElement>('gh-save');
	const statusLine = byId('gh-status');
	const conflictBox = byId('gh-conflict');
	const reloadButton = byId<HTMLButtonElement>('gh-reload');
	const overwriteButton = byId<HTMLButtonElement>('gh-overwrite');
	const warningsList = byId('admin-warnings');

	// --- State --------------------------------------------------------------------------------
	let editor: Editor | null = null;
	/** The serialized scene that GitHub (or the bundled copy, before any load) is known to hold. */
	let baseline = serializeScene(bundled.scene);
	/** Blob sha of the file on GitHub; null until it was loaded or saved once. */
	let sha: string | null = null;
	let busy = false;
	let dirty = false;
	/** Bumped on every data change; lets a slow request notice that the user edited meanwhile. */
	let editCount = 0;

	const setStatus = (text: string, kind: 'info' | 'success' | 'error' = 'info') => {
		statusLine.textContent = text;
		statusLine.dataset.kind = kind;
	};
	const showWarnings = (lines: string[]) => {
		warningsList.replaceChildren(
			...lines.map((line) => {
				const item = document.createElement('li');
				item.textContent = line;
				return item;
			}),
		);
		warningsList.hidden = lines.length === 0;
	};
	/** One line per room/model whose objects are kept in the file but cannot be shown or edited here. */
	const keptNotes = (scene: SceneData): string[] => {
		const notes: string[] = [];
		for (const [slug, room] of Object.entries(scene.rooms)) {
			const counts = new Map<string, number>();
			for (const object of room.objects) {
				if (!knownTypes.has(object.type)) counts.set(object.type, (counts.get(object.type) ?? 0) + 1);
			}
			for (const [type, n] of counts) {
				notes.push(`room "${slug}": ${n} object(s) of unknown type "${type}" kept but not shown (they are saved unchanged).`);
			}
		}
		return notes;
	};
	const showConflict = (visible: boolean) => {
		conflictBox.hidden = !visible;
	};

	const refreshButtons = () => {
		saveButton.disabled = busy || !dirty;
		loadButton.disabled = busy;
		reloadButton.disabled = busy;
		overwriteButton.disabled = busy;
		saveButton.setAttribute('aria-busy', String(busy));
	};
	const refreshDirty = () => {
		dirty = !!editor && serializeScene(editor.getScene()) !== baseline;
		indicator.dataset.dirty = String(dirty);
		indicatorText.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
		refreshButtons();
	};

	// --- Editor ---------------------------------------------------------------------------------
	const fieldValue = (object: SceneObject, field: string): number => {
		const [key, axis] = field.split('-') as ['position' | 'rotation' | 'scale', string];
		return object[key][Number(axis)];
	};

	const refreshSelection = () => {
		if (!editor) return;
		const object = editor.getSelected();
		selectionPanel.hidden = !object;
		selectionEmpty.hidden = !!object;
		if (!object) return;
		selectionLabel.textContent = catalogEntry(object.type)?.label ?? object.type;
		colorInput.value = object.color ?? catalogEntry(object.type)?.defaultColor ?? '#ffffff';
		for (const input of numberFields) {
			if (input === document.activeElement) continue; // do not fight the user's typing
			input.value = String(fieldValue(object, input.dataset.field ?? ''));
		}
	};

	/** The selected room's wall colour: its override, or the family.ts colour it falls back to. */
	const refreshWallColor = () => {
		if (!editor) return;
		const override = editor.getWallColor();
		const family = rooms.find((r) => r.slug === editor?.room);
		wallInput.value = override ?? family?.colors.leftWall ?? '#ffffff';
		wallReset.disabled = override === null;
	};

	let settingsPanel: SettingsPanel | null = null;

	const refreshMode = () => {
		if (!editor) return;
		for (const [mode, button] of Object.entries(modeButtons)) {
			button.setAttribute('aria-pressed', String(editor.getMode() === mode));
		}
		optSnap.checked = editor.getSnap();
		optBounds.checked = editor.getBounds();
	};

	const refreshCatalog = () => {
		const full = !!editor && editor.getObjectCount() >= LIMITS.maxObjectsPerRoom;
		for (const button of catalogBox.querySelectorAll('button')) {
			button.disabled = full;
			button.title = full ? `A room can hold at most ${LIMITS.maxObjectsPerRoom} objects.` : '';
		}
		duplicateButton.disabled = full;
	};

	const onEditorChange = (reason: ChangeReason) => {
		if (reason === 'drag') {
			// Per pointer move: no scene clone/serialize here. Show "unsaved" at once; the exact
			// comparison with the baseline happens when the drag ends ('edit').
			editCount++;
			if (!dirty) {
				dirty = true;
				indicator.dataset.dirty = 'true';
				indicatorText.textContent = 'Unsaved changes';
				refreshButtons();
			}
		} else if (reason === 'edit' || reason === 'scene') {
			editCount++;
			refreshDirty();
			refreshCatalog();
			refreshWallColor();
			if (reason === 'scene' && editor) settingsPanel?.set(editor.getSettings()); // Load latest: show what was loaded
		} else if (reason === 'room') {
			refreshCatalog();
			refreshWallColor();
		}
		refreshSelection();
		if (reason === 'mode') refreshMode();
	};

	editor = createEditor({ canvas, rooms, scene: bundled.scene, onChange: onEditorChange });
	if (!editor) {
		byId('admin-no-webgl').hidden = false;
		canvas.hidden = true;
		// Nothing to preview or edit without the editor: no settings, no wall colour.
		byId('settings-section').hidden = true;
		wallInput.disabled = true;
		wallReset.disabled = true;
	}
	showWarnings([...bundled.warnings, ...keptNotes(bundled.scene)]);

	settingsPanel = mountSettingsPanel(settingsBox, {
		initial: bundled.scene.settings,
		onChange: (next) => editor?.setSettings(next),
	});
	wallInput.addEventListener('input', () => editor?.setWallColor(wallInput.value));
	wallReset.addEventListener('click', () => editor?.setWallColor(null));

	for (const entry of CATALOG) {
		const button = document.createElement('button');
		button.type = 'button';
		button.dataset.addType = entry.type;
		button.textContent = entry.label;
		button.className =
			'rounded-full px-3 py-1.5 text-sm font-medium text-stone-700 ring-1 ring-stone-300 outline-offset-2 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-stone-900';
		button.addEventListener('click', () => editor?.addObject(entry.type));
		catalogBox.append(button);
	}

	// A focused <select> swallows the W/E/R/Esc/Del hotkeys, so leave it after a mouse pick. A keyboard
	// user stepping through the rooms with the arrow keys keeps focus (and so can keep stepping).
	let pickedWithPointer = false;
	roomSelect.addEventListener('pointerdown', () => (pickedWithPointer = true));
	roomSelect.addEventListener('keydown', () => (pickedWithPointer = false));
	roomSelect.addEventListener('change', () => {
		editor?.setRoom(roomSelect.value);
		if (pickedWithPointer) roomSelect.blur();
		pickedWithPointer = false;
	});
	for (const [mode, button] of Object.entries(modeButtons)) {
		button.addEventListener('click', () => editor?.setMode(mode as TransformMode));
	}
	optSnap.addEventListener('change', () => editor?.setSnap(optSnap.checked));
	optBounds.addEventListener('change', () => editor?.setBounds(optBounds.checked));
	colorInput.addEventListener('input', () => editor?.setSelectedColor(colorInput.value));
	colorReset.addEventListener('click', () => editor?.setSelectedColor(null));
	duplicateButton.addEventListener('click', () => editor?.duplicateSelected());
	deleteButton.addEventListener('click', () => editor?.deleteSelected());
	for (const input of numberFields) {
		input.addEventListener('change', () => {
			if (!editor || !editor.getSelected()) return;
			const key = (input.dataset.field ?? '').split('-')[0] as 'position' | 'rotation' | 'scale';
			const group = numberFields.filter((other) => other.dataset.field?.startsWith(`${key}-`));
			// A blank or non-numeric field is not "0": put the real values back and change nothing.
			const blank = group.some((other) => other.value.trim() === '' || !Number.isFinite(Number(other.value)));
			if (!blank) {
				const patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 } = {};
				patch[key] = group.map((other) => Number(other.value)) as Vec3;
				editor.setSelectedTransform(patch);
			}
			// Show what was actually kept (it may have been clamped or rejected), focused field included.
			const kept = editor.getSelected();
			if (kept) for (const other of group) other.value = String(fieldValue(kept, other.dataset.field ?? ''));
		});
	}

	// --- Token and repository settings -----------------------------------------------------------
	const stored = loadToken(session, local);
	tokenInput.value = stored.token;
	rememberInput.checked = stored.remembered;
	const target = loadTarget(local);
	for (const key of Object.keys(targetInputs) as (keyof GithubTarget)[]) {
		targetInputs[key].value = target[key];
		targetInputs[key].addEventListener('change', () => saveTarget(readTarget(), local));
	}

	function readTarget(): GithubTarget {
		return {
			owner: targetInputs.owner.value.trim(),
			repo: targetInputs.repo.value.trim(),
			branch: targetInputs.branch.value.trim(),
			path: targetInputs.path.value.trim(),
		};
	}
	const readToken = () => tokenInput.value.trim();
	const persistToken = () => saveToken(readToken(), rememberInput.checked, session, local);
	tokenInput.addEventListener('change', persistToken);
	rememberInput.addEventListener('change', persistToken);
	forgetButton.addEventListener('click', () => {
		forgetToken(session, local);
		tokenInput.value = '';
		rememberInput.checked = false;
		setStatus('Token forgotten. It is no longer stored on this device.');
	});

	// --- GitHub ---------------------------------------------------------------------------------------
	const client = () => {
		persistToken();
		return createGithubClient({ token: readToken(), target: readTarget() });
	};

	/** Runs a request with the buttons locked and every failure turned into a status line. */
	async function guarded(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		showConflict(false);
		refreshButtons();
		try {
			await action();
		} catch (error) {
			if (!(error instanceof GithubError)) console.error(error); // never carries the token
			setStatus(describeError(error), 'error');
			if (error instanceof GithubError && error.kind === 'conflict') showConflict(true);
		} finally {
			busy = false;
			refreshButtons();
		}
	}

	/** Parses what GitHub holds. Throws a GithubError('bad-response') when it cannot be used as a scene. */
	function parseRemote(text: string) {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new GithubError('bad-response', 'The scene file on GitHub is not valid JSON, so it was not loaded.');
		}
		const result = parseScene(json, parseOptions);
		if (!result.ok) {
			throw new GithubError('bad-response', `The scene file on GitHub cannot be used: ${result.warnings[0]}`);
		}
		return result;
	}

	async function load() {
		const editsBefore = editCount;
		const file = await client().getFile();
		if (editCount !== editsBefore) {
			// Replacing the scene now would silently throw away what was just changed.
			throw new GithubError('edited-meanwhile', 'You edited while loading, so nothing was replaced. Click "Load latest" again.');
		}
		const remote = parseRemote(file.text);
		editor?.setScene(remote.scene);
		baseline = serializeScene(remote.scene);
		sha = file.sha;
		refreshDirty();
		showWarnings([...remote.warnings, ...keptNotes(remote.scene)]);
		setStatus('Loaded the latest scene from GitHub.', 'success');
	}

	// Loading replaces unsaved edits, so a click on "Load latest" with edits needs a second click.
	let confirmTimer = 0;
	const resetLoadButton = () => {
		window.clearTimeout(confirmTimer);
		confirmTimer = 0;
		loadButton.textContent = 'Load latest';
	};
	loadButton.addEventListener('click', () => {
		if (dirty && !confirmTimer) {
			loadButton.textContent = 'Discard my edits and load?';
			confirmTimer = window.setTimeout(resetLoadButton, CONFIRM_MS);
			return;
		}
		resetLoadButton();
		void guarded(load);
	});
	reloadButton.addEventListener('click', () => void guarded(load));

	async function save(overwrite: boolean) {
		const text = serializeScene(editor?.getScene() ?? bundled.scene);
		const problems = validateScene(JSON.parse(text), parseOptions);
		if (problems.length) {
			showWarnings(problems);
			throw new GithubError('invalid-config', 'The scene has problems and was not saved. See the list below.');
		}
		const github = client();
		if (!sha || overwrite) {
			const file = await github.getFile();
			// First save without "Load latest": only go on if GitHub still holds what this page started from.
			if (!overwrite) {
				let remoteText: string;
				try {
					remoteText = serializeScene(parseRemote(file.text).scene);
				} catch (error) {
					// Unreadable remote file: offer Overwrite (which skips this read) so it can be repaired from here.
					const reason = error instanceof GithubError ? error.message.replace(/\.$/, '') : 'unknown problem';
					throw new GithubError(
						'conflict',
						`The file on GitHub cannot be read as a scene (${reason}). You can overwrite it with your version.`,
					);
				}
				if (remoteText !== baseline) {
					throw new GithubError('conflict', 'The file on GitHub is different from the version this page started with.');
				}
			}
			sha = file.sha;
		}
		setStatus('Saving…');
		const result = await github.putFile({ text, message: messageInput.value.trim() || DEFAULT_MESSAGE, sha });
		sha = result.sha;
		baseline = text;
		refreshDirty();
		showWarnings(keptNotes(editor?.getScene() ?? bundled.scene));
		setStatus('Saved — site rebuilding (~1–2 min).', 'success');
	}
	saveButton.addEventListener('click', () => void guarded(() => save(false)));
	overwriteButton.addEventListener('click', () => void guarded(() => save(true)));

	// Reflect problems with the settings right away instead of on the first request.
	for (const input of Object.values(targetInputs)) {
		input.addEventListener('change', () => {
			const problem = validateTarget(readTarget());
			if (problem) setStatus(problem, 'error');
		});
	}

	// --- Leaving the page ---------------------------------------------------------------------------
	window.addEventListener('beforeunload', (event: BeforeUnloadEvent) => {
		if (!dirty) return;
		event.preventDefault();
		event.returnValue = ''; // required by some browsers to show the prompt
	});
	window.addEventListener('pagehide', () => editor?.dispose());
	window.addEventListener('pageshow', (event) => {
		if (event.persisted) location.reload(); // back/forward cache brings back a disposed editor
	});

	refreshMode();
	refreshDirty();
	refreshCatalog();
	refreshSelection();
	refreshWallColor();
	setStatus(
		readToken()
			? 'Token ready. "Load latest" fetches the current scene from GitHub.'
			: 'Editing the copy bundled with this build. Enter a token to load or save.',
	);
}
