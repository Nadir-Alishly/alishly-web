// Admin-only side of the model catalog: reading a model from memory (a GLB the admin just imported),
// registering it for the editor, and freeing it again. Kept out of room-objects.ts so none of this
// reaches the public room bundles; room-objects.ts only has the small addModelEntry / removeModelEntry hooks.
import { Box3, Vector3 } from 'three';
import type { Mesh, Object3D, Texture } from 'three';
import type { ModelEntry, Vec3 } from '../../data/scene';
import { addModelEntry, removeModelEntry } from '../room-objects';

/** Loads a GLB from memory (no request). `path` is empty on purpose: the model has no external files. */
async function parseGlb(buffer: ArrayBuffer): Promise<Object3D> {
	const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
	const gltf = await new GLTFLoader().parseAsync(buffer.slice(0), '');
	if (!gltf.scene) throw new Error('The model has no visible geometry.');
	return gltf.scene;
}

/** Frees everything a loaded model owns: geometries, materials and their textures. */
function disposeTemplate(root: Object3D) {
	const textures = new Set<Texture>();
	root.traverse((node) => {
		const { geometry, material } = node as Partial<Mesh>;
		geometry?.dispose();
		for (const m of Array.isArray(material) ? material : material ? [material] : []) {
			for (const value of Object.values(m)) if ((value as Partial<Texture> | null)?.isTexture) textures.add(value as Texture);
			m.dispose();
		}
	});
	for (const texture of textures) {
		texture.dispose();
		(texture.image as { close?: () => void } | null)?.close?.(); // ImageBitmap: release the pixels
	}
}

/**
 * Reads a model without registering it: throws when it cannot be loaded, otherwise returns its size
 * (bounding box, in the model's own units) so the admin can suggest a scale. Frees what it loaded.
 */
export async function inspectModel(glb: ArrayBuffer): Promise<{ size: Vec3 }> {
	const content = await parseGlb(glb);
	try {
		const size = new Box3().setFromObject(content).getSize(new Vector3());
		if (![size.x, size.y, size.z].every(Number.isFinite) || size.x + size.y + size.z === 0) {
			throw new Error('The model has no visible geometry.');
		}
		return { size: [size.x, size.y, size.z] };
	} finally {
		disposeTemplate(content);
	}
}

/** Adds a model to the catalog; its GLB is read from `glb` instead of `entry.file`. Throws if the id is taken. */
export function registerModel(entry: ModelEntry, glb: ArrayBuffer): void {
	addModelEntry(entry, () => parseGlb(glb));
}

/** Removes a model from the catalog and frees its loaded data. */
export function unregisterModel(id: string): void {
	void removeModelEntry(id)?.then(disposeTemplate, () => {});
}
