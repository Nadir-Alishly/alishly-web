// The /admin scene editor: picks, moves, rotates, scales, adds, duplicates, recolours and deletes the
// objects of one room at a time, for all rooms in memory. Admin-only: this is the only place that
// imports TransformControls, so it never reaches the public room bundles.
//
// `data` (a SceneData) is the source of truth; the three.js objects are a view of it. Every mutation
// of the view goes through core.invalidate() because the renderer only paints on demand.
import { Box3, BoxHelper, MathUtils, Raycaster, Vector2 } from 'three';
import type { Object3D } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { RoomColors } from '../../data/family';
import {
	LIMITS,
	ROOM_BOUNDS,
	cloneScene,
	modelIdOf,
	roundTo,
	shiftIntoRange,
} from '../../data/scene';
import type { SceneData, SceneObject, Vec3 } from '../../data/scene';
import { createRoomCore } from '../room-core';
import { catalogEntry, createObjectData } from '../room-objects';

export type TransformMode = 'translate' | 'rotate' | 'scale';
/**
 * `drag` fires on every pointer move while a gizmo handle is dragged (cheap handlers only); the
 * `edit` that settles it follows when the drag ends.
 */
export type ChangeReason = 'edit' | 'drag' | 'selection' | 'mode' | 'room' | 'scene';

export interface RoomInfo {
	slug: string;
	name: string;
	colors: RoomColors;
}

export interface EditorOptions {
	canvas: HTMLCanvasElement;
	rooms: readonly RoomInfo[];
	scene: SceneData;
	/** Called after every change the UI may want to reflect. `edit`, `drag` and `scene` change the data. */
	onChange?: (reason: ChangeReason) => void;
}

export interface Editor {
	readonly room: string;
	getScene(): SceneData;
	/** Number of objects in the current room; Add is refused at LIMITS.maxObjectsPerRoom. */
	getObjectCount(): number;
	/** Replace all rooms' data (e.g. after "Load latest"). Clears the selection. */
	setScene(scene: SceneData): void;
	setRoom(slug: string): void;
	/** Adds a catalog entry to the current room, selects it and returns its id (null if the type is unknown). */
	addObject(type: string): string | null;
	duplicateSelected(): void;
	deleteSelected(): void;
	select(id: string | null): void;
	getSelected(): SceneObject | null;
	getMode(): TransformMode;
	setMode(mode: TransformMode): void;
	getSnap(): boolean;
	setSnap(on: boolean): void;
	getBounds(): boolean;
	setBounds(on: boolean): void;
	/** `null` goes back to the catalog default. */
	setSelectedColor(hex: string | null): void;
	/** Typed values are not snapped; they are kept inside the room when that option is on. */
	setSelectedTransform(patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }): void;
	dispose(): void;
}

const GRID = 0.25;
const ROTATION_STEP = 15; // degrees
const SCALE_STEP = 0.1;
const CLICK_SLOP = 5; // px between pointerdown and pointerup that still counts as a click
const DUPLICATE_OFFSET = 0.5;

// Where new objects try to land: near the middle of the floor, stepping away from occupied spots.
const SPOTS = (
	[
		[0, 0],
		[1, 0],
		[0, 1],
		[-1, 0],
		[0, -1],
		[1, 1],
		[-1, 1],
		[-1, -1],
		[1, -1],
		[2, 0],
		[0, 2],
		[-2, 0],
		[0, -2],
	] as [number, number][]
).map(([x, z]): [number, number] => [x * 0.75, z * 0.75]);

const AXES = [0, 1, 2] as const;

const isTyping = (target: EventTarget | null) => {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
	if (target instanceof HTMLInputElement) {
		return !['checkbox', 'radio', 'button', 'range', 'submit', 'reset'].includes(target.type);
	}
	return false;
};

/** Returns null when WebGL cannot start. */
export function createEditor(options: EditorOptions): Editor | null {
	const { canvas, rooms } = options;
	const info = (slug: string) => rooms.find((r) => r.slug === slug) ?? rooms[0];
	let data = cloneScene(options.scene);
	for (const r of rooms) data.rooms[r.slug] ??= { objects: [] };
	let room = rooms[0].slug;

	const core = createRoomCore(canvas, { name: info(room).name, colors: info(room).colors });
	if (!core) return null;
	const { objects } = core;

	let mode: TransformMode = 'translate';
	let snap = true;
	let bounds = true;
	let selected: string | null = null;
	let highlight: BoxHelper | null = null;
	let disposed = false;
	// Models that were just added: once loaded, their real size is known and they get fitted into the room.
	const pendingFit = new Set<string>();

	const emit = (reason: ChangeReason) => options.onChange?.(reason);
	const roomObjects = () => data.rooms[room].objects;
	// Objects of a model that is not in the catalog (models.json broken or entry removed) stay in the
	// data, so Save writes them back unchanged, but they have no 3D view and cannot be selected.
	const shownObjects = () => roomObjects().filter((o) => catalogEntry(o.type) !== undefined);
	const find = (id: string) => roomObjects().find((o) => o.id === id);
	const describe = () =>
		`Editable isometric view of ${info(room).name}'s room. Click an object to select it, drag the arrows to move it, drag empty space to rotate the view.`;
	canvas.setAttribute('aria-label', describe());

	// --- Gizmo and highlight ---------------------------------------------------------------------
	const gizmo = new TransformControls(core.camera, canvas);
	gizmo.setMode(mode);
	const gizmoHelper = gizmo.getHelper();
	core.scene.add(gizmoHelper);

	const applySnap = () => {
		gizmo.setTranslationSnap(snap ? GRID : null);
		gizmo.setRotationSnap(snap ? MathUtils.degToRad(ROTATION_STEP) : null);
		gizmo.setScaleSnap(snap ? SCALE_STEP : null);
	};
	applySnap();

	const clearHighlight = () => {
		if (!highlight) return;
		core.scene.remove(highlight);
		highlight.geometry.dispose();
		(highlight.material as { dispose(): void }).dispose();
		highlight = null;
	};
	const updateHighlight = () => {
		const holder = selected ? objects.get(selected) : undefined;
		if (!holder) return clearHighlight();
		if (!highlight) {
			highlight = new BoxHelper(holder, 0x1c1917);
			core.scene.add(highlight);
		}
		highlight.update();
	};

	// --- Keeping things inside the room, and data <-> three.js ---------------------------------------
	/** Shifts `holder` so its bounding box lies inside the room; no-op while a model is still loading. */
	const fitIntoRoom = (holder: Object3D) => {
		holder.updateMatrixWorld(true);
		const box = new Box3().setFromObject(holder);
		if (box.isEmpty()) return;
		for (const axis of AXES) {
			const key = (['x', 'y', 'z'] as const)[axis];
			holder.position[key] += shiftIntoRange(box.min[key], box.max[key], ROOM_BOUNDS.min[axis], ROOM_BOUNDS.max[axis]);
		}
		holder.updateMatrixWorld(true);
	};

	/**
	 * Copies the holder's transform back into the data, first forcing it into the ranges the validator
	 * accepts (a scale handle dragged through the origin gives 0, negative or NaN). Corrected values are
	 * written back to the holder so the view always equals the data.
	 */
	const readBack = (object: SceneObject, holder: Object3D) => {
		const sane = (value: number, fallback: number, lo: number, hi: number) =>
			Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
		const differs = (a: number, b: number) => !(Math.abs(a - b) < 1e-9); // true for NaN too
		const { position: p, rotation: r, scale: s } = holder;
		const pos = LIMITS.maxPosition;
		const rot = LIMITS.maxRotation;
		const position: Vec3 = [
			sane(p.x, object.position[0], -pos, pos),
			sane(p.y, object.position[1], -pos, pos),
			sane(p.z, object.position[2], -pos, pos),
		];
		const rotation: Vec3 = [
			sane(MathUtils.radToDeg(r.x), object.rotation[0], -rot, rot),
			sane(MathUtils.radToDeg(r.y), object.rotation[1], -rot, rot),
			sane(MathUtils.radToDeg(r.z), object.rotation[2], -rot, rot),
		];
		const scale: Vec3 = [
			sane(s.x, object.scale[0], LIMITS.minScale, LIMITS.maxScale),
			sane(s.y, object.scale[1], LIMITS.minScale, LIMITS.maxScale),
			sane(s.z, object.scale[2], LIMITS.minScale, LIMITS.maxScale),
		];
		object.position = [roundTo(position[0]), roundTo(position[1]), roundTo(position[2])];
		object.rotation = [roundTo(rotation[0]), roundTo(rotation[1]), roundTo(rotation[2])];
		object.scale = [roundTo(scale[0]), roundTo(scale[1]), roundTo(scale[2])];
		if (differs(position[0], p.x) || differs(position[1], p.y) || differs(position[2], p.z)) {
			holder.position.set(...position);
		}
		if (
			differs(rotation[0], MathUtils.radToDeg(r.x)) ||
			differs(rotation[1], MathUtils.radToDeg(r.y)) ||
			differs(rotation[2], MathUtils.radToDeg(r.z))
		) {
			holder.rotation.set(
				MathUtils.degToRad(rotation[0]),
				MathUtils.degToRad(rotation[1]),
				MathUtils.degToRad(rotation[2]),
			);
		}
		if (differs(scale[0], s.x) || differs(scale[1], s.y) || differs(scale[2], s.z)) holder.scale.set(...scale);
		holder.updateMatrixWorld(true);
	};

	const onGizmoObjectChange = () => {
		const object = selected ? find(selected) : undefined;
		const holder = selected ? objects.get(selected) : undefined;
		if (!object || !holder) return;
		if (bounds) fitIntoRoom(holder);
		readBack(object, holder);
		updateHighlight();
		core.invalidate();
		emit('drag');
	};
	gizmo.addEventListener('objectChange', onGizmoObjectChange);
	gizmo.addEventListener('change', () => core.invalidate());
	// Orbit and the gizmo share the canvas: orbit must stand still while a gizmo handle is dragged.
	gizmo.addEventListener('dragging-changed', (event) => {
		core.controls.enabled = !event.value;
		if (!event.value) emit('edit'); // the drag ended: let the UI do its full (costly) comparison once
	});

	objects.onLoad = (id) => {
		const object = find(id);
		const holder = objects.get(id);
		if (object && holder && pendingFit.delete(id) && bounds) {
			fitIntoRoom(holder);
			readBack(object, holder);
			emit('edit');
		}
		if (id === selected) updateHighlight();
		core.invalidate();
	};

	// --- Selection ---------------------------------------------------------------------------------
	const select = (id: string | null) => {
		const holder = id ? objects.get(id) : undefined;
		selected = holder && id ? id : null;
		if (holder) gizmo.attach(holder);
		else gizmo.detach();
		updateHighlight();
		core.invalidate();
		emit('selection');
	};

	// --- Pointer picking: a click (not a drag) on an object selects it, on empty space deselects ---------
	const raycaster = new Raycaster();
	const ndc = new Vector2();
	let press: { x: number; y: number; onGizmo: boolean } | null = null;

	const onPointerDown = (event: PointerEvent) => {
		// The gizmo's own listener ran first (it was registered earlier); `axis` is set when a handle is grabbed.
		press = event.button === 0 ? { x: event.clientX, y: event.clientY, onGizmo: gizmo.axis !== null } : null;
	};
	const onPointerUp = (event: PointerEvent) => {
		const start = press;
		press = null;
		if (!start || start.onGizmo || event.button !== 0) return;
		if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
		const rect = canvas.getBoundingClientRect();
		ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
		raycaster.setFromCamera(ndc, core.camera);
		select(objects.idAt(raycaster));
	};
	canvas.addEventListener('pointerdown', onPointerDown);
	canvas.addEventListener('pointerup', onPointerUp);

	// --- Actions --------------------------------------------------------------------------------------
	const newId = (type: string) => {
		const base = type.replace(/[^A-Za-z0-9_-]/g, '-');
		for (;;) {
			const id = `${base}-${Math.random().toString(36).slice(2, 8)}`;
			if (!roomObjects().some((o) => o.id === id)) return id;
		}
	};

	/** Puts `object` into the current room's data and view, fitted into the room, and selects it. */
	const insert = (object: SceneObject) => {
		roomObjects().push(object);
		const holder = objects.add(object);
		if (bounds) fitIntoRoom(holder);
		readBack(object, holder);
		if (modelIdOf(object.type) !== null) pendingFit.add(object.id);
		select(object.id);
		emit('edit');
	};

	const setMode = (next: TransformMode) => {
		mode = next;
		gizmo.setMode(next);
		core.invalidate();
		emit('mode');
	};

	const editor: Editor = {
		get room() {
			return room;
		},
		getScene: () => cloneScene(data),
		getObjectCount: () => roomObjects().length,

		setScene(next) {
			select(null);
			data = cloneScene(next);
			for (const r of rooms) data.rooms[r.slug] ??= { objects: [] };
			pendingFit.clear();
			objects.replaceAll(shownObjects());
			core.invalidate();
			emit('scene');
		},

		setRoom(slug) {
			if (!rooms.some((r) => r.slug === slug) || slug === room) return;
			select(null);
			room = slug;
			pendingFit.clear();
			objects.replaceAll(shownObjects());
			core.setRoom({ name: info(room).name, colors: info(room).colors });
			canvas.setAttribute('aria-label', describe());
			emit('room');
		},

		addObject(type) {
			const entry = catalogEntry(type);
			if (!entry || roomObjects().length >= LIMITS.maxObjectsPerRoom) return null;
			const free = SPOTS.find(([x, z]) =>
				roomObjects().every((o) => Math.hypot(o.position[0] - x, o.position[2] - z) > 0.6),
			);
			const [x, z] = free ?? SPOTS[0];
			const object = createObjectData(type, newId(type), [x, 0, z]);
			insert(object);
			return object.id;
		},

		duplicateSelected() {
			const source = selected ? find(selected) : undefined;
			if (!source || roomObjects().length >= LIMITS.maxObjectsPerRoom) return;
			const copy = JSON.parse(JSON.stringify(source)) as SceneObject;
			copy.id = newId(source.type);
			copy.position = [
				roundTo(source.position[0] + DUPLICATE_OFFSET),
				source.position[1],
				roundTo(source.position[2] + DUPLICATE_OFFSET),
			];
			insert(copy);
		},

		deleteSelected() {
			if (!selected) return;
			const id = selected;
			select(null);
			const list = roomObjects();
			const index = list.findIndex((o) => o.id === id);
			if (index >= 0) list.splice(index, 1);
			pendingFit.delete(id);
			objects.remove(id);
			core.invalidate();
			emit('edit');
		},

		select,
		getSelected: () => {
			const object = selected ? find(selected) : undefined;
			return object ? (JSON.parse(JSON.stringify(object)) as SceneObject) : null;
		},
		getMode: () => mode,
		setMode,
		getSnap: () => snap,
		setSnap(on) {
			snap = on;
			applySnap();
			emit('mode');
		},
		getBounds: () => bounds,
		setBounds(on) {
			bounds = on;
			emit('mode');
		},

		setSelectedColor(hex) {
			const object = selected ? find(selected) : undefined;
			if (!object) return;
			if (hex === null) delete object.color;
			else if (/^#[0-9a-fA-F]{6}$/.test(hex)) object.color = hex.toLowerCase();
			else return;
			objects.update(object);
			core.invalidate();
			emit('edit');
		},

		setSelectedTransform(patch) {
			const object = selected ? find(selected) : undefined;
			if (!object) return;
			const finite = (v: Vec3 | undefined, ok: (n: number) => boolean) =>
				v !== undefined && v.length === 3 && v.every((n) => Number.isFinite(n) && ok(n));
			if (finite(patch.position, (n) => Math.abs(n) <= LIMITS.maxPosition)) object.position = [...patch.position!];
			if (finite(patch.rotation, (n) => Math.abs(n) <= LIMITS.maxRotation)) object.rotation = [...patch.rotation!];
			if (finite(patch.scale, (n) => n >= LIMITS.minScale && n <= LIMITS.maxScale)) object.scale = [...patch.scale!];
			objects.update(object);
			const holder = objects.get(object.id);
			if (holder && bounds) {
				fitIntoRoom(holder);
				readBack(object, holder);
			}
			updateHighlight();
			core.invalidate();
			emit('edit');
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			window.removeEventListener('keydown', onKeyDown);
			canvas.removeEventListener('pointerdown', onPointerDown);
			canvas.removeEventListener('pointerup', onPointerUp);
			objects.onLoad = null;
			gizmo.detach();
			core.scene.remove(gizmoHelper);
			gizmo.dispose();
			clearHighlight();
			core.dispose();
		},
	};

	// --- Keyboard ---------------------------------------------------------------------------------------
	function onKeyDown(event: KeyboardEvent) {
		if (disposed || isTyping(event.target)) return;
		const key = event.key.toLowerCase();
		if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'd') {
			event.preventDefault(); // the browser would bookmark the page
			editor.duplicateSelected();
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (key === 'w') setMode('translate');
		else if (key === 'e') setMode('rotate');
		else if (key === 'r') setMode('scale');
		else if (key === 'escape') select(null);
		else if ((key === 'delete' || key === 'backspace') && selected) {
			event.preventDefault();
			editor.deleteSelected();
		}
	}
	window.addEventListener('keydown', onKeyDown);

	objects.replaceAll(shownObjects());
	core.invalidate();
	return editor;
}
