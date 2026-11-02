// The live preview of a model that is being imported (admin only): a ghost in the room from the moment a file is picked
// until Add or Cancel, at the spot "Add to room" would use, at the form's scale. It is NOT scene data: it lives straight
// in the three.js scene, not under the object manager's root, so it is never picked or selected, never in the object
// list, undo, getScene(), Save or the catalog, and it raises no `edit`. Everything it makes is disposed by clear().
import { Group } from 'three';
import type { Material, Mesh, Object3D, Scene } from 'three';
import { ghostOpacity, previewObjectScale } from '../../data/import-preview';
import type { Vec3 } from '../../data/scene';
import { instantiateModel, disposeInstance, prepareTemplate } from '../room-objects';
import { disposeTemplate, parseGlb } from './model-registry';

export interface ImportPreview {
	/** Shows this model (replacing the previous preview). The GLB is parsed once; later scale changes reuse it. */
	show(glb: ArrayBuffer, defaultScale: number): void;
	/** Rebuilds the ghost at a new default scale (the scale is baked into an instance, so it is a rebuild). */
	setScale(defaultScale: number): void;
	/** Moves the ghost to where the room's next new object would go now; does nothing when that is where it already is. */
	relocate(): void;
	/** Removes the ghost and frees its model. Safe to call more than once. */
	clear(): void;
}

export interface ImportPreviewOptions {
	scene: Scene;
	/** Where "Add to room" would put a new object: [x, 0, z]. */
	spot(): Vec3;
	/** Shifts the holder inside the room when "Keep inside the room" is on. */
	fit(holder: Object3D): void;
	/** Whether `fit` is on: with `spot`, what decides where the ghost stands (relocate() rebuilds only when it changed). */
	fitOn(): boolean;
	/** The picture changed: repaint. Never the editor's `edit`. */
	repaint(): void;
}

export function createImportPreview(options: ImportPreviewOptions): ImportPreview {
	let template: Group | null = null;
	let ghost: Group | null = null;
	let scale = 1;
	// Where the ghost would stand now: the spot plus the fit setting. The ghost's own key is kept to compare with.
	const placementKey = (spot: Vec3) => `${spot.join(',')}|${options.fitOn()}`;
	let placedAt = '';
	let token = 0; // a parse that finishes after clear()/another show() is thrown away

	const dropGhost = () => {
		if (!ghost) return;
		options.scene.remove(ghost);
		disposeInstance(ghost); // its cloned materials; the geometry belongs to the template
		ghost = null;
	};
	const dropTemplate = () => {
		if (!template) return;
		disposeTemplate(template);
		template = null;
	};

	const build = () => {
		dropGhost();
		if (!template) return;
		const native = (template.userData.nativeSize as Vec3 | undefined) ?? null;
		const holder = new Group();
		holder.name = 'import-preview';
		holder.add(instantiateModel(template, scale));
		holder.traverse((node) => {
			const mesh = node as Partial<Mesh>;
			node.castShadow = false;
			node.receiveShadow = false;
			if (!mesh.material) return;
			node.raycast = () => {}; // not pickable, whatever ray-tests the scene
			for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) ghostify(material);
		});
		holder.scale.set(...previewObjectScale(native, scale).scale);
		const spot = options.spot();
		placedAt = placementKey(spot);
		holder.position.set(...spot);
		holder.updateMatrixWorld(true);
		options.fit(holder);
		holder.updateMatrixWorld(true);
		ghost = holder;
		options.scene.add(holder);
		options.repaint();
	};

	return {
		show(glb, defaultScale) {
			const mine = ++token;
			dropGhost();
			dropTemplate();
			scale = defaultScale;
			options.repaint();
			void parseGlb(glb).then(
				(content) => {
					const prepared = prepareTemplate(content);
					if (mine !== token) return disposeTemplate(prepared); // cleared or replaced while parsing
					template = prepared;
					build();
				},
				(error) => {
					if (mine === token) console.warn('Could not preview the model.', error);
				},
			);
		},
		setScale(defaultScale) {
			if (defaultScale === scale) return;
			scale = defaultScale;
			build(); // no template yet (still parsing): show() builds with the latest scale
		},
		relocate() {
			if (template && placedAt !== placementKey(options.spot())) build();
		},
		clear() {
			token++;
			const had = ghost !== null || template !== null;
			dropGhost();
			dropTemplate();
			if (had) options.repaint(); // no ghost, nothing changed: no shadow-map re-render
		},
	};
}

/** A see-through, shadowless copy of a material: translucent, drawn without writing depth. Owned by the ghost's instance. */
function ghostify(material: Material) {
	material.transparent = true;
	material.opacity = ghostOpacity(material.opacity);
	material.depthWrite = false;
	material.needsUpdate = true;
}
