// Model-only lighting: gives the MeshStandard/MeshPhysical materials of imported (GLTF) models their own environment
// map and intensity, per object. A material with its own `envMap` ignores `scene.environment`, so the scene's low global
// environment (which keeps the Lambert walls and floor as calibrated) is not touched, and a model WITHOUT its own envMap
// keeps today's look (scene.environment at fill.envIntensity). Pure and three-free (duck-typed, type imports only), so
// Node can import it for tests.

/** The slice of a three.js material this helper reads and writes. */
interface LightableMaterial {
	isMeshStandardMaterial?: boolean;
	envMap?: unknown;
	envMapIntensity?: number;
	aoMapIntensity?: number;
	needsUpdate?: boolean;
	userData?: Record<string, unknown>;
}

const AUTHORED_AO = 'authoredAoIntensity';

/** Remembers the material's own (file-authored) aoMapIntensity, once. Call it on a fresh clone before any lighting. */
export function recordAuthoredAo(material: object): void {
	const m = material as LightableMaterial;
	if (!m.isMeshStandardMaterial || !m.userData || m.userData[AUTHORED_AO] !== undefined) return;
	m.userData[AUTHORED_AO] = m.aoMapIntensity ?? 1;
}

/**
 * Lights one material.
 * - `envLight` = strength: `envMap` = `env` and `envMapIntensity` = `envLight` (the model's own environment light).
 *   `null` (not opted in) = no own envMap, so the scene's environment applies, as before this feature.
 * - `aoIntensity` scales the model's own AO-map strength for every model: aoMapIntensity = authored x aoIntensity
 *   (1 = as authored, so switching off or resetting restores the file's value exactly).
 * Only MeshStandardMaterial and its subclasses (MeshPhysicalMaterial) are touched; Lambert/Basic/etc. are left alone.
 * Returns whether the material was lightable. The texture stays owned by room-core: never dispose it through a material.
 */
export function applyModelLighting(
	material: object,
	env: unknown | null,
	envLight: number | null,
	aoIntensity: number,
): boolean {
	const m = material as LightableMaterial;
	if (!m.isMeshStandardMaterial) return false;
	recordAuthoredAo(m);
	const next = envLight === null ? null : (env ?? null);
	if ((m.envMap ?? null) !== next) {
		m.envMap = next; // a different shader variant (USE_ENVMAP): the program must be rebuilt
		m.needsUpdate = true;
	}
	if (envLight !== null) m.envMapIntensity = envLight;
	m.aoMapIntensity = ((m.userData?.[AUTHORED_AO] as number | undefined) ?? 1) * aoIntensity;
	return true;
}

export interface ModelLightingNode {
	material?: object | object[] | null;
	children?: readonly ModelLightingNode[];
}

/** Applies applyModelLighting() to every material under `root` (a node with `material` and children). */
export function applyModelLightingTo(root: ModelLightingNode, env: unknown | null, envLight: number | null, aoIntensity: number) {
	const { material } = root;
	for (const m of Array.isArray(material) ? material : material ? [material] : []) applyModelLighting(m, env, envLight, aoIntensity);
	for (const child of root.children ?? []) applyModelLightingTo(child, env, envLight, aoIntensity);
}
