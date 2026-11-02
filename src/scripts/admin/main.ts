// Wires the /admin page: DOM controls <-> editor <-> GitHub client.
// Everything user-visible that comes from GitHub or from the token goes through textContent only.
import { SIZE_LIMIT_HINT } from '../../data/object-size';
import { LIMITS, parseModels, parseScene, serializeScene, validateScene } from '../../data/scene';
import type { ParseOptions, SceneData, SceneObject, Vec3 } from '../../data/scene';
import { catalogEntry } from '../room-objects';
import { GITHUB_WORDING } from './backend';
import type { Wording } from './backend';
import { createEditor } from './editor';
import type { ChangeReason, Editor, RoomInfo, TransformMode } from './editor';
import {
	DEFAULT_TARGET,
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
import type { GithubClient, GithubTarget, StorageLike } from './github';
import { mountModelLibrary } from './model-library';
import { MODELS_JSON_PATH } from './model-ops';
import type { ModelLibrary } from './model-library';
import { buildObjectRows, objectRowsSignature } from './object-list';
import type { ObjectRow } from './object-list';
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
	const envLightRow = byId('sel-envlight-row');
	const envLightCheck = byId<HTMLInputElement>('sel-envlight');
	const envLightValue = byId<HTMLInputElement>('sel-envlight-value');
	const titleInput = byId<HTMLInputElement>('sel-title');
	const titleCount = byId('sel-title-count');
	const paragraphInput = byId<HTMLTextAreaElement>('sel-paragraph');
	const paragraphCount = byId('sel-paragraph-count');
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
	const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
	const saveTab = byId<HTMLButtonElement>('tab-save');
	const saveTabFlag = byId('tab-save-flag');
	const tabAnnounce = byId('tab-announce');
	const objectsSection = byId('objects-section');
	const objectList = byId('object-list');
	const objectListEmpty = byId('object-list-empty');
	const sizeHint = byId('size-hint');

	// --- State --------------------------------------------------------------------------------
	let editor: Editor | null = null;
	let library: ModelLibrary | null = null;
	/** The serialized scene that GitHub (or the bundled copy, before any load) is known to hold. */
	let baseline = serializeScene(bundled.scene);
	/** Blob sha of the file on GitHub; null until it was loaded or saved once. */
	let sha: string | null = null;
	let busy = false;
	/** The row last scrolled into view in the object list (see markSelectedRow). */
	let listScrolledTo: string | null = null;
	let dirty = false;
	/** Bumped on every data change; lets a slow request notice that the user edited meanwhile. */
	let editCount = 0;

	// --- Tabs: This room | All rooms | Save -------------------------------------------------------
	// Only show/hide: switching tabs never touches the scene, the selection or the unsaved state.
	const activeTab = () => tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
	const showTab = (tab: HTMLButtonElement, focus = false) => {
		for (const other of tabs) {
			const selectedTab = other === tab;
			other.setAttribute('aria-selected', String(selectedTab));
			other.tabIndex = selectedTab ? 0 : -1;
			const panel = document.getElementById(other.getAttribute('aria-controls') ?? '');
			if (panel) panel.hidden = !selectedTab;
		}
		if (tab === saveTab) {
			saveTabFlag.hidden = true; // seen
			tabAnnounce.textContent = '';
		}
		if (tab.id === 'tab-room') {
			// The list could not scroll the selected row into view while its tab was hidden.
			listScrolledTo = null;
			markSelectedRow();
		}
		if (focus) tab.focus();
	};
	/** A GitHub problem on another tab: mark the Save tab so it is not missed. */
	const flagSaveTab = () => {
		if (activeTab() === saveTab || !saveTabFlag.hidden) return;
		saveTabFlag.hidden = false;
		tabAnnounce.textContent = 'The Save tab needs attention.'; // live region: screen readers hear it
	};
	for (const tab of tabs) {
		tab.addEventListener('click', () => showTab(tab));
		tab.addEventListener('keydown', (event) => {
			if (event.altKey || event.ctrlKey || event.metaKey) return; // browser/OS shortcuts (Alt+Left = back)
			const index = tabs.indexOf(tab);
			let next: number | null = null;
			if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
			else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
			else if (event.key === 'Home') next = 0;
			else if (event.key === 'End') next = tabs.length - 1;
			if (next === null) return;
			event.preventDefault();
			showTab(tabs[next], true);
		});
	}

	const setStatus = (text: string, kind: 'info' | 'success' | 'error' = 'info') => {
		statusLine.textContent = text;
		statusLine.dataset.kind = kind;
		if (kind === 'error') flagSaveTab();
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
				if (!catalogEntry(object.type)) counts.set(object.type, (counts.get(object.type) ?? 0) + 1);
			}
			for (const [type, n] of counts) {
				notes.push(`room "${slug}": ${n} object(s) of unknown type "${type}" kept but not shown (they are saved unchanged).`);
			}
		}
		return notes;
	};
	const showConflict = (visible: boolean) => {
		conflictBox.hidden = !visible;
		if (visible) flagSaveTab();
	};

	const refreshButtons = () => {
		saveButton.disabled = busy || !dirty;
		loadButton.disabled = busy;
		reloadButton.disabled = busy;
		overwriteButton.disabled = busy;
		saveButton.setAttribute('aria-busy', String(busy));
		library?.refresh();
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

	/** The object whose note the Title/Paragraph fields currently show. */
	let noteFieldsFor: string | null = null;
	const refreshSelection = () => {
		if (!editor) return;
		const object = editor.getSelected();
		selectionPanel.hidden = !object;
		selectionEmpty.hidden = !!object;
		if (!object) return;
		selectionLabel.textContent = catalogEntry(object.type)?.label ?? object.type;
		colorInput.value = object.color ?? catalogEntry(object.type)?.defaultColor ?? '#ffffff';
		// Environment light: models only; the strength field is left alone while it is being typed in.
		envLightRow.hidden = catalogEntry(object.type)?.kind !== 'model';
		envLightCheck.checked = object.envLight !== undefined;
		envLightValue.disabled = object.envLight === undefined;
		if (envLightValue !== document.activeElement) envLightValue.value = object.envLight === undefined ? '' : String(object.envLight);
		// The note fields: never overwrite the one being typed in (unless another object was selected meanwhile).
		const switched = object.id !== noteFieldsFor;
		noteFieldsFor = object.id;
		if (switched || titleInput !== document.activeElement) titleInput.value = object.title ?? '';
		if (switched || paragraphInput !== document.activeElement) paragraphInput.value = object.paragraph ?? '';
		titleCount.textContent = `${titleInput.value.length} / ${LIMITS.maxTitle}`;
		paragraphCount.textContent = `${paragraphInput.value.length} / ${LIMITS.maxParagraph}`;
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

	// --- Objects in this room ------------------------------------------------------------------------
	const ROW_CLASS =
		'min-w-0 flex-1 truncate rounded-lg px-2.5 py-1.5 text-left text-sm text-stone-800 outline-offset-2 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-stone-900 aria-[current=true]:bg-stone-900 aria-[current=true]:text-white';
	const DELETE_CLASS =
		'shrink-0 rounded-full px-2 py-1 text-sm text-red-700 outline-offset-2 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-stone-900';
	let listSignature: string | null = null;

	const rowElement = (row: ObjectRow) => {
		const item = document.createElement('li');
		item.dataset.id = row.id;
		item.className = 'flex items-center gap-1';
		if (!row.available) {
			item.className += ' rounded-lg px-2.5 py-1.5 text-sm text-stone-400';
			item.textContent = row.label;
			return item;
		}
		const select = document.createElement('button');
		select.type = 'button';
		select.dataset.action = 'select';
		select.dataset.id = row.id;
		select.className = ROW_CLASS;
		select.textContent = row.label;
		select.title = row.label; // the label is truncated when long
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.dataset.action = 'delete';
		remove.dataset.id = row.id;
		remove.className = DELETE_CLASS;
		remove.setAttribute('aria-label', row.deleteLabel ?? 'Delete');
		remove.title = row.deleteLabel ?? 'Delete';
		remove.textContent = '✕';
		if (row.hasNote) {
			const marker = document.createElement('span');
			marker.dataset.noteMarker = '';
			marker.className = 'shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800';
			marker.title = 'Has a note';
			marker.textContent = 'note';
			item.append(select, marker, remove);
		} else {
			item.append(select, remove);
		}
		return item;
	};
	const selectButtons = () => [...objectList.querySelectorAll<HTMLButtonElement>('button[data-action="select"]')];

	/** Marks the selected row (aria-current) and keeps it in view. Cheap: no DOM is created. */
	const markSelectedRow = () => {
		const selectedId = editor?.getSelectedId() ?? null;
		const buttons = selectButtons();
		for (const button of buttons) {
			if (button.dataset.id === selectedId) button.setAttribute('aria-current', 'true');
			else button.removeAttribute('aria-current');
		}
		if (selectedId !== listScrolledTo) {
			listScrolledTo = selectedId;
			// While typing in the note fields the page must not jump (the list can rebuild when the first/last character toggles the marker).
			if (document.activeElement === titleInput || document.activeElement === paragraphInput) return;
			buttons.find((button) => button.dataset.id === selectedId)?.scrollIntoView({ block: 'nearest' });
		}
	};

	/** Rebuilds the list only when ids, order, labels or availability changed (not on colour or transform edits). */
	const refreshObjectList = () => {
		if (!editor) return;
		const rows = buildObjectRows(editor.getObjects(), (type) => catalogEntry(type)?.label);
		const signature = objectRowsSignature(rows);
		if (signature !== listSignature) {
			listSignature = signature;
			// Keep keyboard focus on the same row (or the one that took its place) across the rebuild.
			const focused = objectList.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
			const focusedId = focused?.dataset.id ?? null;
			const focusedAction = focused?.dataset.action ?? 'select';
			const previousIndex = focusedId ? [...objectList.children].findIndex((li) => (li as HTMLElement).dataset.id === focusedId) : -1;
			objectList.replaceChildren(...rows.map(rowElement));
			objectListEmpty.hidden = rows.length > 0;
			if (focusedId) {
				let target = objectList.querySelector<HTMLElement>(`button[data-action="${focusedAction}"][data-id="${CSS.escape(focusedId)}"]`);
				if (!target) {
					// The focused row is gone: land on the row now at its place (or the last selectable one).
					const buttons = selectButtons();
					target = buttons.find((button) => rows.findIndex((row) => row.id === button.dataset.id) >= previousIndex) ?? buttons[buttons.length - 1] ?? null;
				}
				target?.focus();
			}
			listScrolledTo = null;
		}
		markSelectedRow();
	};

	objectList.addEventListener('click', (event) => {
		const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-action]');
		if (!button || !editor) return;
		const id = button.dataset.id ?? '';
		// After a mouse click the list must not keep the keyboard (it owns W/E/R/Esc/Del while focused): leave it
		// before acting, so the rebuild has no focus to restore. A keyboard activation (detail 0) keeps its place.
		if (event.detail > 0) button.blur();
		if (button.dataset.action === 'select') editor.select(id);
		else if (button.dataset.action === 'delete') editor.deleteObject(id);
	});
	// The list swallows the hotkeys while focused (so Del never deletes another object), but Esc still deselects.
	objectList.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey) editor?.select(null);
	});

	// The size limit changed a scale: a short hint in the Selected object panel, where the user is working.
	let sizeHintTimer = 0;
	const hideSizeHint = () => {
		window.clearTimeout(sizeHintTimer);
		sizeHintTimer = 0;
		sizeHint.hidden = true;
		sizeHint.textContent = '';
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
			refreshObjectList();
			if (reason === 'scene' && editor) settingsPanel?.set(editor.getSettings()); // Load latest: show what was loaded
		} else if (reason === 'room') {
			refreshCatalog();
			refreshWallColor();
			refreshObjectList();
		} else if (reason === 'selection') {
			hideSizeHint();
			markSelectedRow();
		}
		refreshSelection();
		if (reason === 'mode') refreshMode();
	};

	const onSizeLimit = () => {
		if (sizeHint.textContent !== SIZE_LIMIT_HINT) sizeHint.textContent = SIZE_LIMIT_HINT;
		sizeHint.hidden = false;
		window.clearTimeout(sizeHintTimer);
		sizeHintTimer = window.setTimeout(hideSizeHint, 5000);
	};

	editor = createEditor({ canvas, rooms, scene: bundled.scene, onChange: onEditorChange, onSizeLimit });
	if (!editor) {
		byId('admin-no-webgl').hidden = false;
		canvas.hidden = true;
		// Nothing to preview or edit without the editor: no settings, no wall colour.
		byId('settings-section').hidden = true;
		objectsSection.hidden = true;
		wallInput.disabled = true;
		wallReset.disabled = true;
	}
	showWarnings([...bundled.warnings, ...keptNotes(bundled.scene)]);

	settingsPanel = mountSettingsPanel(settingsBox, {
		initial: bundled.scene.settings,
		onChange: (next) => editor?.setSettings(next),
	});
	library = mountModelLibrary({
		root,
		roomNames: new Map(rooms.map((room) => [room.slug, `${room.name}'s room`])),
		slugs: rooms.map((room) => room.slug),
		getScene: () => editor?.getScene() ?? bundled.scene,
		run: guarded,
		isBusy: () => busy,
		client: () => client(),
		scenePath: () => (import.meta.env.DEV ? DEFAULT_TARGET.path : readTarget().path),
		wording: () => wording,
		onPreview: (glb, defaultScale) => editor?.setImportPreview(glb, defaultScale),
		onPreviewScale: (defaultScale) => editor?.setImportPreviewScale(defaultScale),
		onCatalogChange: () => {
			renderCatalog();
			refreshObjectList(); // model labels may have changed
			refreshSelection();
		},
	});

	wallInput.addEventListener('input', () => editor?.setWallColor(wallInput.value));
	wallReset.addEventListener('click', () => editor?.setWallColor(null));

	/** (Re)builds the "Add to room" pills: the primitives and the models that are not queued for deletion. */
	const renderCatalog = () => {
		catalogBox.replaceChildren(
			...(library?.catalog() ?? []).map((entry) => {
				const button = document.createElement('button');
				button.type = 'button';
				button.dataset.addType = entry.type;
				button.textContent = entry.label;
				button.className =
					'rounded-full px-3 py-1.5 text-sm font-medium text-stone-700 ring-1 ring-stone-300 outline-offset-2 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-stone-900';
				button.addEventListener('click', () => editor?.addObject(entry.type));
				return button;
			}),
		);
		refreshCatalog();
	};
	renderCatalog();

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
	envLightCheck.addEventListener('change', () => {
		if (!editor) return;
		// Ticking starts from the Scene settings default; unticking removes the field again.
		// Never below the scene's own environment intensity: that strength looks the same as "off", lower would be darker.
		const defaults = editor.getSettings();
		editor.setSelectedEnvLight(envLightCheck.checked ? Math.max(defaults.objects.envIntensity, defaults.fill.envIntensity) : null);
		refreshSelection();
	});
	envLightValue.addEventListener('input', () => {
		const value = envLightValue.valueAsNumber;
		if (Number.isFinite(value)) editor?.setSelectedEnvLight(value); // empty or half-typed: wait
	});
	// On blur/Enter show what is stored (typed values are clamped to 0-3; an emptied field goes back to the stored strength).
	envLightValue.addEventListener('change', () => {
		const stored = editor?.getSelected()?.envLight;
		envLightValue.value = stored === undefined ? '' : String(stored);
	});
	titleInput.addEventListener('input', () => editor?.setSelectedTitle(titleInput.value));
	paragraphInput.addEventListener('input', () => editor?.setSelectedParagraph(paragraphInput.value));
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
	/** What the user is told about where things are saved; GitHub unless the dev-only disk backend is active. */
	let wording: Wording = GITHUB_WORDING;
	/** The status line as first written; the dev backend replaces it only if nothing else was said since. */
	let initialStatus = '';

	const githubClient = () => {
		persistToken();
		return createGithubClient({ token: readToken(), target: readTarget() });
	};

	/**
	 * DEV ONLY (`astro dev`): Save / Load / model saves go to the working tree through the dev server, and NEVER to
	 * GitHub. Everything about it sits behind `import.meta.env.DEV`, which the build replaces with `false`, so neither
	 * this code nor local-client.ts reaches `dist`. A failed probe is not remembered: the next action probes again.
	 */
	let devClientReady: GithubClient | null = null;
	let devProbe: Promise<GithubClient> | null = null;
	const probeDevBackend = (): Promise<GithubClient> => {
		if (devClientReady) return Promise.resolve(devClientReady);
		return (devProbe ??= (async () => {
			try {
				let local: typeof import('./local-client');
				try {
					local = await import('./local-client');
				} catch {
					throw new GithubError('bad-response', 'Local save: its script could not be loaded (see the browser console). Nothing was saved.');
				}
				const probe = await local.probeLocal();
				if (!probe.ok) throw new GithubError('network', probe.message);
				const created = local.createLocalClient();
				wording = local.LOCAL_WORDING;
				if (statusLine.textContent === initialStatus) setStatus(wording.ready);
				devClientReady = created;
				void refreshLocalBanner();
				// Armed on EVERY successful probe, before the caller's action goes on: a broken hand edit blocks Save at once.
				await checkLocalData(created);
				return created;
			} finally {
				devProbe = null;
			}
		})());
	};
	/** Shows " — differs from committed" in the always-visible dev banner when local/ scene or models differ. Never throws. */
	async function refreshLocalBanner() {
		try {
			const local = await import('./local-client');
			const differs = await local.fetchDiffers();
			const flag = document.getElementById('dev-local-differs');
			if (flag && differs !== null) flag.hidden = !differs;
		} catch {
			// the banner keeps its last state
		}
	}
	/** The Save tab without the GitHub-only inputs, plus the dev note. Tolerates missing nodes. */
	function useDiskLayout() {
		for (const element of root.querySelectorAll<HTMLElement>('[data-github-only]')) element.hidden = true;
		const heading = document.getElementById('github-heading');
		if (heading) heading.textContent = 'Save to disk';
		saveButton.textContent = 'Save to disk';
		const note = document.getElementById('dev-save-note');
		if (note) note.hidden = false;
	}
	/**
	 * DEV ONLY. Problems found in local/scene.json / local/models.json (hand edits): while there are any, Save and
	 * Save models are blocked, so a broken-but-fixable file is not overwritten by an empty scene built from it.
	 * Cleared by a "Load latest" (or a page reload) that reads valid data.
	 */
	let localProblems: string[] = [];
	let localBlockStatus = '';
	const localBlockMessage = () =>
		`Saving is blocked: ${localProblems.join('; ')}. Fix the file in local/, then click "Load latest".`;
	function showLocalProblems() {
		const box = document.getElementById('dev-local-problem');
		if (box) {
			box.textContent = localProblems.length > 0 ? `${localProblems.join('; ')} — fix the file, then click "Load latest" (Save is blocked until then).` : '';
			box.hidden = localProblems.length === 0;
		}
		if (localProblems.length > 0) {
			localBlockStatus = localBlockMessage();
			setStatus(localBlockStatus, 'error'); // also flags the Save tab
		} else if (localBlockStatus && statusLine.textContent === localBlockStatus) {
			setStatus('');
			localBlockStatus = '';
		}
	}
	/** Reads local/scene.json and local/models.json through the dev client and records what is wrong with them. */
	// Takes the client as an argument (not `devClient`): probeDevBackend -> checkLocalData -> devClient -> probeDevBackend would
	// be a reference cycle that the minifier cannot drop, and the dev code would then leak into the production bundle.
	async function checkLocalData(local: GithubClient) {
		const found: string[] = [];
		/** The text of one local file, or null with the problem recorded; `unreachable` when the endpoint cannot answer. */
		const readOne = async (name: string, read: () => Promise<{ text: string }>): Promise<string | null | 'unreachable'> => {
			try {
				return (await read()).text;
			} catch (error) {
				if (error instanceof GithubError && (error.kind === 'network' || error.kind === 'timeout')) return 'unreachable';
				// Anything else (invalid UTF-8, too large, a bad answer ...) means the file cannot be used: block, naming it.
				const why = error instanceof GithubError ? error.message.replace(/\.$/, '') : 'unexpected error';
				found.push(`local/${name} cannot be read (${why})`);
				return null;
			}
		};
		// Separate reads, so a problem in one file is kept when the other cannot be read either.
		const sceneText = await readOne('scene.json', () => local.getFile());
		const modelsText = await readOne('models.json', () => local.getFileAt(MODELS_JSON_PATH, ''));
		if (sceneText === 'unreachable' || modelsText === 'unreachable') return; // probeDevBackend reports that; keep the old state
		if (sceneText !== null) {
			let json: unknown;
			let parsed = true;
			try {
				json = JSON.parse(sceneText);
			} catch {
				parsed = false;
				found.push('local/scene.json is not valid JSON');
			}
			if (parsed) {
				const result = parseScene(json, parseOptions);
				if (!result.ok) found.push(`local/scene.json cannot be used as a scene (${result.warnings[0]})`);
			}
		}
		if (modelsText !== null) {
			try {
				const list: unknown = JSON.parse(modelsText);
				if (!Array.isArray(list)) found.push('local/models.json is not a list of models');
				else if (parseModels(list).length !== list.length) found.push('local/models.json has entries that cannot be read');
			} catch {
				found.push('local/models.json is not valid JSON');
			}
		}
		localProblems = found;
		showLocalProblems();
	}
	const devClient: GithubClient = {
		getFile: async () => (await probeDevBackend()).getFile(),
		putFile: async (args) => {
			if (localProblems.length > 0) throw new GithubError('invalid-config', localBlockMessage());
			return (await probeDevBackend()).putFile(args);
		},
		getFileAt: async (path, ref) => (await probeDevBackend()).getFileAt(path, ref),
		getBlobSha: async (path, ref) => (await probeDevBackend()).getBlobSha(path, ref),
		getHead: async () => (await probeDevBackend()).getHead(),
		commitFiles: async (args) => {
			if (localProblems.length > 0) throw new GithubError('invalid-config', localBlockMessage());
			return (await probeDevBackend()).commitFiles(args);
		},
	};

	const client = (): GithubClient => (import.meta.env.DEV ? devClient : githubClient());

	/** Scene failures: a status line, plus Reload/Overwrite for a conflict. */
	function reportSceneError(error: unknown) {
		if (!(error instanceof GithubError)) console.error(error); // never carries the token
		setStatus(describeError(error), 'error');
		if (error instanceof GithubError && error.kind === 'conflict') showConflict(true);
	}

	/**
	 * Runs a request with the buttons locked (scene Save and Save models share this lock, so they cannot
	 * overlap) and every failure turned into a status line by `onError`.
	 */
	async function guarded(action: () => Promise<void>, onError: (error: unknown) => void = reportSceneError) {
		if (busy) return;
		busy = true;
		if (onError === reportSceneError) showConflict(false);
		// A library action replaces a stale "Save models first" line from a blocked scene Save (it is resolved by now).
		else if (conflictBox.hidden && statusLine.textContent?.startsWith('Save models first')) setStatus('');
		refreshButtons();
		try {
			// Dev: the backend decision (and its wording) must be known before anything runs.
			if (import.meta.env.DEV) await probeDevBackend();
			await action();
			if (import.meta.env.DEV) void refreshLocalBanner(); // a save can change whether local/ differs
		} catch (error) {
			onError(error);
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
			throw new GithubError('bad-response', `The scene file on ${wording.where} is not valid JSON, so it was not loaded.`);
		}
		const result = parseScene(json, parseOptions);
		if (!result.ok) {
			throw new GithubError('bad-response', `The scene file on ${wording.where} cannot be used: ${result.warnings[0]}`);
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
		setStatus(wording.loaded, 'success');
		library?.checkRemovals();
		if (import.meta.env.DEV) await checkLocalData(await probeDevBackend()); // a fixed hand edit unblocks Save here
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
		if (import.meta.env.DEV && localProblems.length > 0) throw new GithubError('invalid-config', localBlockMessage());
		const scene = editor?.getScene() ?? bundled.scene;
		// The site is built from the repository: an object of a model that is not committed yet would show a broken box.
		const unsaved = library?.pendingUsedBy(scene) ?? [];
		if (unsaved.length > 0) {
			throw new GithubError('invalid-config', `Save models first: ${unsaved.join(', ')}. The scene uses models that are not on ${wording.where} yet.`);
		}
		const text = serializeScene(scene);
		const problems = validateScene(JSON.parse(text), parseOptions);
		if (problems.length) {
			showWarnings(problems);
			throw new GithubError('invalid-config', 'The scene has problems and was not saved. See the list below.');
		}
		const github = client();
		if (!sha || overwrite) {
			const file = await github.getFile();
			// First save without "Load latest": only go on if the backend still holds what this page started from.
			if (!overwrite) {
				let remoteText: string;
				try {
					remoteText = serializeScene(parseRemote(file.text).scene);
				} catch (error) {
					// Unreadable remote file: offer Overwrite (which skips this read) so it can be repaired from here.
					const reason = error instanceof GithubError ? error.message.replace(/\.$/, '') : 'unknown problem';
					throw new GithubError(
						'conflict',
						`The file on ${wording.where} cannot be read as a scene (${reason}). You can overwrite it with your version.`,
					);
				}
				if (remoteText !== baseline) {
					throw new GithubError('conflict', `The file on ${wording.where} is different from the version this page started with.`);
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
		setStatus(wording.sceneSaved, 'success');
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
		if (!dirty && !library?.hasPending()) return;
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
	refreshObjectList();
	initialStatus = import.meta.env.DEV
		? ''
		: readToken()
			? 'Token ready. "Load latest" fetches the current scene from GitHub.'
			: GITHUB_WORDING.ready;
	setStatus(initialStatus);
	if (import.meta.env.DEV) {
		// Disk replaces GitHub in dev: show the disk layout right away and report a missing endpoint in the status line.
		useDiskLayout();
		probeDevBackend().catch(reportSceneError);
	}
}
