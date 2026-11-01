// Furniture for the rooms: the catalog (low-poly primitives + GLTF models) and the manager that turns
// scene.json objects into three.js objects inside a room.
//
// Adding a GLTF model: import it in /admin ("Model library": a .glb, or a .gltf with its files, up to
// 25 MB), place it, then "Save models" commits public/models/<id>.glb plus one entry in
// src/data/models.json:
//   { "id": "sofa", "label": "Sofa", "file": "/models/sofa.glb", "defaultScale": 1 }
// (Both can also be written by hand.) The model can then be placed (type "model:sofa") and appears on
// the site after the next build. Models are re-centred on x/z and rest on y = 0 whatever their file's
// origin is; `defaultScale` is applied inside, so an object's own scale of [1,1,1] always means "as
// listed". Static meshes only (no skins/animations).
// The model list is fixed at build time; only the admin changes it at runtime (admin/model-registry.ts,
// through addModelEntry / removeModelEntry; models imported on the page that are not deployed yet are read from memory).
// GLTFLoader is imported lazily, so rooms without models never download it.
import { BoxGeometry, Box3, Color, CylinderGeometry, Group, MathUtils, Mesh, MeshLambertMaterial } from 'three';
import type { Material, Object3D, Raycaster } from 'three';
import { models } from '../data/models';
import { MODEL_PREFIX, PRIMITIVE_TYPES, isPrimitiveType, modelIdOf } from '../data/scene';
import type { ModelEntry, PrimitiveType, SceneObject, Vec3 } from '../data/scene';

export interface CatalogEntry {
	/** The value stored in scene.json: a primitive name or `model:<id>`. */
	type: string;
	label: string;
	kind: 'primitive' | 'model';
	/** `#rrggbb`; null for models, which keep their own colours until recoloured. */
	defaultColor: string | null;
	defaultScale: number;
}

// --- Primitives ------------------------------------------------------------------------------
// Every part is a box or a cylinder with its BASE at `at.y` and centred on `at.x/at.z`, so an object at
// y = 0 stands on the floor. Roles: `main` is the object's colour, `accent` a darker shade of it, any
// other string is a fixed colour that the colour picker does not touch.

type Role = 'main' | 'accent' | string;
type Part =
	| { shape: 'box'; size: Vec3; at: Vec3; role: Role }
	| { shape: 'cyl'; radiusTop: number; radiusBottom: number; height: number; at: Vec3; role: Role };

const box = (size: Vec3, at: Vec3, role: Role): Part => ({ shape: 'box', size, at, role });
const cyl = (radiusTop: number, radiusBottom: number, height: number, at: Vec3, role: Role): Part => ({
	shape: 'cyl',
	radiusTop,
	radiusBottom,
	height,
	at,
	role,
});

const ACCENT_SHADE = 0.72;

const PRIMITIVES: Record<PrimitiveType, { label: string; color: string; parts: Part[] }> = {
	bed: {
		label: 'Bed',
		color: '#c9b8e8',
		parts: [
			box([1.6, 0.3, 2], [0, 0.1, 0], 'accent'),
			box([1.5, 0.22, 1.9], [0, 0.4, 0.02], 'main'),
			box([1.6, 0.85, 0.1], [0, 0.1, -0.95], 'accent'),
			box([0.62, 0.12, 0.34], [-0.38, 0.62, -0.7], '#fbf8f2'),
			box([0.62, 0.12, 0.34], [0.38, 0.62, -0.7], '#fbf8f2'),
		],
	},
	table: {
		label: 'Table',
		color: '#c8a27a',
		parts: [
			box([1.4, 0.1, 0.8], [0, 0.7, 0], 'main'),
			box([0.1, 0.7, 0.1], [-0.62, 0, -0.32], 'accent'),
			box([0.1, 0.7, 0.1], [0.62, 0, -0.32], 'accent'),
			box([0.1, 0.7, 0.1], [-0.62, 0, 0.32], 'accent'),
			box([0.1, 0.7, 0.1], [0.62, 0, 0.32], 'accent'),
		],
	},
	chair: {
		label: 'Chair',
		color: '#d9b38c',
		parts: [
			box([0.5, 0.08, 0.5], [0, 0.45, 0], 'main'),
			box([0.5, 0.5, 0.06], [0, 0.53, -0.22], 'main'),
			box([0.06, 0.45, 0.06], [-0.2, 0, -0.2], 'accent'),
			box([0.06, 0.45, 0.06], [0.2, 0, -0.2], 'accent'),
			box([0.06, 0.45, 0.06], [-0.2, 0, 0.2], 'accent'),
			box([0.06, 0.45, 0.06], [0.2, 0, 0.2], 'accent'),
		],
	},
	shelf: {
		label: 'Shelf',
		color: '#c8a27a',
		parts: [
			box([0.05, 1.6, 0.35], [-0.425, 0, 0], 'accent'),
			box([0.05, 1.6, 0.35], [0.425, 0, 0], 'accent'),
			box([0.8, 1.6, 0.03], [0, 0, -0.16], 'accent'),
			box([0.8, 0.04, 0.35], [0, 0, 0], 'main'),
			box([0.8, 0.04, 0.35], [0, 0.52, 0], 'main'),
			box([0.8, 0.04, 0.35], [0, 1.04, 0], 'main'),
			box([0.8, 0.04, 0.35], [0, 1.56, 0], 'main'),
		],
	},
	lamp: {
		label: 'Lamp',
		color: '#f2d98a',
		parts: [
			cyl(0.18, 0.2, 0.05, [0, 0, 0], 'accent'),
			cyl(0.03, 0.03, 1.2, [0, 0.05, 0], '#7d7a76'),
			cyl(0.15, 0.28, 0.35, [0, 1.15, 0], 'main'),
		],
	},
	rug: {
		label: 'Rug',
		color: '#e8a0a0',
		parts: [
			box([2, 0.03, 1.4], [0, 0, 0], 'accent'),
			box([1.76, 0.035, 1.16], [0, 0, 0], 'main'),
		],
	},
	plant: {
		label: 'Plant',
		color: '#6fae6f',
		parts: [
			cyl(0.22, 0.15, 0.32, [0, 0, 0], '#b9714f'),
			cyl(0.02, 0.36, 0.55, [0, 0.3, 0], 'main'),
			cyl(0.02, 0.26, 0.45, [0, 0.7, 0], 'accent'),
		],
	},
	box: {
		label: 'Box',
		color: '#d6b98c',
		parts: [box([0.6, 0.6, 0.6], [0, 0, 0], 'main')],
	},
};

export const PRIMITIVE_CATALOG: readonly CatalogEntry[] = PRIMITIVE_TYPES.map((type) => ({
	type,
	label: PRIMITIVES[type].label,
	kind: 'primitive',
	defaultColor: PRIMITIVES[type].color,
	defaultScale: 1,
}));

// The known models: the build-time list, plus whatever the admin registers while it is open.
const library = new Map<string, ModelEntry>(models.map((model) => [model.id, model]));

const modelCatalogEntry = (model: ModelEntry): CatalogEntry => ({
	type: MODEL_PREFIX + model.id,
	label: model.label,
	kind: 'model',
	defaultColor: null,
	defaultScale: model.defaultScale,
});

/** The primitives followed by the models, as of now. */
export function getCatalog(): readonly CatalogEntry[] {
	return [...PRIMITIVE_CATALOG, ...[...library.values()].map(modelCatalogEntry)];
}

export function catalogEntry(type: string): CatalogEntry | undefined {
	const primitive = PRIMITIVE_CATALOG.find((entry) => entry.type === type);
	if (primitive) return primitive;
	const modelId = modelIdOf(type);
	const model = modelId === null ? undefined : library.get(modelId);
	return model ? modelCatalogEntry(model) : undefined;
}

/** A fresh scene object for the catalog entry, at `position`. */
export function createObjectData(type: string, id: string, position: Vec3): SceneObject {
	return { id, type, position, rotation: [0, 0, 0], scale: [1, 1, 1] };
}

/**
 * Local (unrotated) size of an object's content per unit of the object's own scale, i.e. the native
 * bounding box x the model's defaultScale. Null while a model is loading, when it failed to load, or when
 * the box is degenerate. The admin's size limits (data/object-size.ts) are the only reader.
 */
export function nativeSizeOf(holder: Object3D): Vec3 | null {
	const size = holder.userData.nativeSize as Vec3 | undefined;
	return size ?? null;
}

const boxSize = (box: Box3): Vec3 | null => {
	if (box.isEmpty()) return null;
	const size: Vec3 = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
	return size.every((n) => Number.isFinite(n) && n > 0) ? size : null;
};

// Primitive sizes never change: measure each type once.
const primitiveSizes = new Map<PrimitiveType, Vec3 | null>();

function buildPrimitive(type: PrimitiveType): Group {
	const group = new Group();
	for (const part of PRIMITIVES[type].parts) {
		const [x, y, z] = part.at;
		let mesh: Mesh;
		const material = new MeshLambertMaterial();
		if (part.shape === 'box') {
			const [w, h, d] = part.size;
			mesh = new Mesh(new BoxGeometry(w, h, d), material);
			mesh.position.set(x, y + h / 2, z);
		} else {
			mesh = new Mesh(new CylinderGeometry(part.radiusTop, part.radiusBottom, part.height, 16), material);
			mesh.position.set(x, y + part.height / 2, z);
		}
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.userData.role = part.role;
		if (part.role !== 'main' && part.role !== 'accent') material.color.set(part.role);
		group.add(mesh);
	}
	return group;
}

function setPrimitiveColor(group: Object3D, hex: string) {
	const main = new Color(hex);
	const accent = main.clone().multiplyScalar(ACCENT_SHADE);
	group.traverse((node) => {
		const role = node.userData.role as Role | undefined;
		const material = (node as Partial<Mesh>).material as MeshLambertMaterial | undefined;
		if (!material || Array.isArray(material)) return;
		if (role === 'main') material.color.copy(main);
		else if (role === 'accent') material.color.copy(accent);
	});
}

// --- GLTF models -------------------------------------------------------------------------------

// One loaded template per model for the page's lifetime. Instances share its geometry and textures
// and own their (cloned) materials. Failed loads are dropped from the cache so they can be retried.
const templates = new Map<string, Promise<Object3D>>();

// Models added while the admin is open load through their own function (they are read from memory).
const loaders = new Map<string, () => Promise<Object3D>>();

function loadTemplate(modelId: string): Promise<Object3D> {
	const cached = templates.get(modelId);
	if (cached) return cached;
	const entry = library.get(modelId);
	const promise = (async () => {
		if (!entry) throw new Error(`Unknown model "${modelId}"`);
		const custom = loaders.get(modelId);
		let content: Object3D;
		if (custom) content = await custom();
		else {
			const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
			content = (await new GLTFLoader().loadAsync(entry.file)).scene;
		}
		// Re-centre on x/z and rest on y = 0, so models behave like the primitives.
		const bounds = new Box3().setFromObject(content);
		content.position.x -= (bounds.min.x + bounds.max.x) / 2;
		content.position.z -= (bounds.min.z + bounds.max.z) / 2;
		content.position.y -= bounds.min.y;
		const wrapper = new Group();
		wrapper.add(content);
		const nativeSize = boxSize(bounds);
		if (nativeSize) wrapper.userData.nativeSize = nativeSize;
		return wrapper;
	})();
	templates.set(modelId, promise);
	promise.catch(() => templates.delete(modelId));
	return promise;
}

/** Admin hook: adds a model to the catalog; `load` yields its scene instead of fetching `entry.file`. Throws if the id is taken. */
export function addModelEntry(entry: ModelEntry, load: () => Promise<Object3D>): void {
	if (library.has(entry.id)) throw new Error(`Model "${entry.id}" already exists.`);
	library.set(entry.id, { ...entry });
	loaders.set(entry.id, load);
}

/**
 * Admin hook: removes a model from the catalog and forgets its loaded template. Returns that template
 * (if it was loaded) so the caller can dispose it. Objects of the model that are still in a scene stop
 * being shown (the admin refuses to do this while any exist).
 */
export function removeModelEntry(id: string): Promise<Object3D> | undefined {
	library.delete(id);
	loaders.delete(id);
	const template = templates.get(id);
	templates.delete(id);
	return template;
}

function instantiateModel(template: Object3D, defaultScale: number): Group {
	const inner = new Group();
	inner.scale.setScalar(defaultScale);
	inner.userData.sharedGeometry = true; // geometry belongs to the template
	const clone = template.clone(true);
	clone.traverse((node) => {
		const mesh = node as Partial<Mesh>;
		if (!mesh.material) return;
		node.castShadow = true;
		node.receiveShadow = true;
		const own = (m: Material) => {
			const copy = m.clone();
			const color = (copy as Partial<MeshLambertMaterial>).color;
			if (color) copy.userData.baseColor = color.clone();
			return copy;
		};
		mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
	});
	inner.add(clone);
	return inner;
}

function setModelColor(group: Object3D, hex: string | undefined) {
	group.traverse((node) => {
		const material = (node as Partial<Mesh>).material;
		for (const m of Array.isArray(material) ? material : material ? [material] : []) {
			const color = (m as Partial<MeshLambertMaterial>).color;
			const base = m.userData.baseColor as Color | undefined;
			if (!color || !base) continue;
			if (hex) color.set(hex);
			else color.copy(base);
		}
	});
}

/** Shown when a model fails to load, so the object stays visible and selectable. */
function buildMissingModel(): Group {
	const group = new Group();
	const material = new MeshLambertMaterial({ color: '#c0392b', wireframe: true });
	const mesh = new Mesh(new BoxGeometry(0.6, 0.6, 0.6), material);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.position.y = 0.3;
	group.add(mesh);
	return group;
}

// --- Disposal and picking ----------------------------------------------------------------------

/** Frees what one object owns: its materials always, its geometry unless it belongs to a shared template. */
function disposeInstance(node: Object3D, shared = false) {
	const isShared = shared || node.userData.sharedGeometry === true;
	const { geometry, material } = node as Partial<Mesh>;
	if (!isShared) geometry?.dispose();
	for (const m of Array.isArray(material) ? material : material ? [material] : []) m.dispose();
	for (const child of node.children) disposeInstance(child, isShared);
}

// --- Manager -------------------------------------------------------------------------------------

export interface ObjectManager {
	/** Add this group to the scene; every object lives under it. */
	readonly root: Group;
	/** Called after a model finished loading (the object's size/shape just changed). */
	onLoad: ((id: string) => void) | null;
	/** Replace everything with `list`. A no-op when `list` equals what the last setObjects() put in. */
	setObjects(list: readonly SceneObject[]): void;
	/** Like setObjects() but always rebuilds; for callers that keep editing the list in place. */
	replaceAll(list: readonly SceneObject[]): void;
	add(object: SceneObject): Object3D;
	/** Re-apply transform and colour from the data. */
	update(object: SceneObject): void;
	remove(id: string): void;
	get(id: string): Object3D | undefined;
	/**
	 * Raise an object by `y` world units above where its data puts it (hover float); 0 = at rest. The offset
	 * is remembered and re-applied by update(); remove()/replaceAll() forget it. Does not invalidate: the caller paints.
	 */
	setLift(id: string, y: number): void;
	/** Id of the object the ray hits first, or null. */
	idAt(raycaster: Raycaster): string | null;
	dispose(): void;
}

/** `onChange` is called whenever the visible result changed outside of the caller's own action (async loads). */
export function createObjectManager(onChange: () => void): ObjectManager {
	const root = new Group();
	root.name = 'objects';
	const holders = new Map<string, Group>();
	// The most recent data per object, so a late-finishing model load applies the current colour.
	const latest = new Map<string, SceneObject>();
	const lifts = new Map<string, number>();
	const current = (id: string) => latest.get(id);

	let signature: string | null = null;
	let disposed = false;

	const applyColor = (holder: Group, object: SceneObject) => {
		const modelId = modelIdOf(object.type);
		if (modelId === null) {
			const entry = catalogEntry(object.type);
			setPrimitiveColor(holder, object.color ?? entry?.defaultColor ?? '#cccccc');
		} else {
			setModelColor(holder, object.color);
		}
	};

	const applyTransform = (holder: Group, object: SceneObject) => {
		holder.position.set(...object.position);
		holder.position.y += lifts.get(object.id) ?? 0;
		holder.rotation.set(
			MathUtils.degToRad(object.rotation[0]),
			MathUtils.degToRad(object.rotation[1]),
			MathUtils.degToRad(object.rotation[2]),
		);
		holder.scale.set(...object.scale);
		holder.updateMatrixWorld(true);
	};

	function add(object: SceneObject): Object3D {
		remove(object.id);
		signature = null;
		const holder = new Group();
		holder.userData.objectId = object.id;
		holder.userData.type = object.type;
		holders.set(object.id, holder);
		root.add(holder);

		const modelId = modelIdOf(object.type);
		if (modelId === null) {
			if (isPrimitiveType(object.type)) {
				const group = buildPrimitive(object.type);
				if (!primitiveSizes.has(object.type)) primitiveSizes.set(object.type, boxSize(new Box3().setFromObject(group)));
				const size = primitiveSizes.get(object.type);
				if (size) holder.userData.nativeSize = size;
				holder.add(...group.children);
			}
		} else {
			const defaultScale = library.get(modelId)?.defaultScale ?? 1;
			loadTemplate(modelId).then(
				(template) => {
					if (disposed || holders.get(object.id) !== holder) return; // removed meanwhile
					holder.add(instantiateModel(template, defaultScale));
					const nativeSize = template.userData.nativeSize as Vec3 | undefined;
					if (nativeSize) holder.userData.nativeSize = nativeSize.map((n) => n * defaultScale);
					applyColor(holder, current(object.id) ?? object);
					holder.updateMatrixWorld(true);
					onChange();
					manager.onLoad?.(object.id);
				},
				(error) => {
					console.warn(`Could not load model "${modelId}".`, error);
					if (disposed || holders.get(object.id) !== holder) return;
					holder.add(buildMissingModel());
					onChange();
					manager.onLoad?.(object.id);
				},
			);
		}
		// Latest data wins if update() is called while the model is still loading.
		latest.set(object.id, object);
		applyTransform(holder, object);
		applyColor(holder, object);
		onChange();
		return holder;
	}

	function remove(id: string) {
		const holder = holders.get(id);
		if (!holder) return;
		signature = null;
		root.remove(holder);
		disposeInstance(holder);
		holders.delete(id);
		latest.delete(id);
		lifts.delete(id);
		onChange();
	}

	const manager: ObjectManager = {
		root,
		onLoad: null,
		setObjects(list) {
			if (disposed) return;
			const next = JSON.stringify(list);
			if (next === signature) return;
			manager.replaceAll(list);
			signature = next;
		},
		replaceAll(list) {
			if (disposed) return;
			for (const id of [...holders.keys()]) remove(id);
			for (const object of list) add(object);
			signature = null;
		},
		add,
		update(object) {
			const holder = holders.get(object.id);
			if (!holder) return;
			signature = null;
			latest.set(object.id, object);
			applyTransform(holder, object);
			applyColor(holder, object);
			onChange();
		},
		remove,
		get: (id) => holders.get(id),
		setLift(id, y) {
			const holder = holders.get(id);
			const object = latest.get(id);
			if (!holder || !object) return;
			if (y === 0) lifts.delete(id);
			else lifts.set(id, y);
			holder.position.y = object.position[1] + y;
			holder.updateMatrixWorld(true);
		},
		idAt(raycaster) {
			const hit = raycaster.intersectObjects(root.children, true)[0];
			for (let node: Object3D | null = hit?.object ?? null; node; node = node.parent) {
				const id = node.userData.objectId as string | undefined;
				if (id !== undefined) return id;
			}
			return null;
		},
		dispose() {
			if (disposed) return;
			for (const id of [...holders.keys()]) remove(id);
			disposed = true;
		},
	};
	return manager;
}
