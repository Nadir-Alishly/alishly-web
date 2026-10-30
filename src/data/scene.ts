// Scene data model shared by the build, the public viewer and /admin.
// Pure TypeScript with only erasable syntax and no DOM/three/Astro imports, so Node can import it
// directly (`node --test`).

export type Vec3 = [number, number, number];

export interface SceneObject {
	/** Unique within its room. */
	id: string;
	/** A primitive from PRIMITIVE_TYPES, or `model:<id>` for an entry of src/data/models.json. */
	type: string;
	position: Vec3;
	/** Euler XYZ in degrees. */
	rotation: Vec3;
	scale: Vec3;
	/** `#rrggbb`. Omitted = the catalog default. */
	color?: string;
}

export interface RoomObjects {
	objects: SceneObject[];
}

export interface SceneData {
	version: 1;
	rooms: Record<string, RoomObjects>;
}

export const SCENE_VERSION = 1;

export const PRIMITIVE_TYPES = [
	'bed',
	'table',
	'chair',
	'shelf',
	'lamp',
	'rug',
	'plant',
	'box',
] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

export const MODEL_PREFIX = 'model:';

// Room dimensions in world units. The floor top is y = 0.
export const ROOM_DIMS = {
	half: 3.2, // floor is a square from -half to +half on x and z
	inner: 3.0, // inner faces of the two back walls
	wallHeight: 3,
	slab: 0.4,
};

/** The space an object may occupy: in front of the back walls, on the floor, under the wall top. */
export const ROOM_BOUNDS = {
	min: [-ROOM_DIMS.inner, 0, -ROOM_DIMS.inner] as Vec3,
	max: [ROOM_DIMS.half, ROOM_DIMS.wallHeight, ROOM_DIMS.half] as Vec3,
};

export const LIMITS = {
	maxObjectsPerRoom: 500,
	maxPosition: 100,
	minScale: 0.01,
	maxScale: 50,
	maxRotation: 36000,
};

export interface ParseOptions {
	/** Known room slugs. Rooms not in the list are dropped; listed rooms that are missing are added empty. */
	slugs?: readonly string[];
	/** Known model ids (without the `model:` prefix). Objects of another model are dropped. */
	modelIds?: readonly string[];
}

export interface ParseResult {
	/** Always a usable scene: invalid pieces are dropped, never thrown on. */
	scene: SceneData;
	/** One human-readable line per dropped/ignored piece. Empty means the input was fully valid. */
	warnings: string[];
	/** False when the input could not be read as a scene at all (not an object, wrong version, bad `rooms`). */
	ok: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export function emptyScene(slugs: readonly string[]): SceneData {
	const rooms: Record<string, RoomObjects> = {};
	for (const slug of slugs) rooms[slug] = { objects: [] };
	return { version: SCENE_VERSION, rooms };
}

export function isPrimitiveType(type: string): type is PrimitiveType {
	return (PRIMITIVE_TYPES as readonly string[]).includes(type);
}

export function modelIdOf(type: string): string | null {
	return type.startsWith(MODEL_PREFIX) ? type.slice(MODEL_PREFIX.length) : null;
}

function parseVec3(
	value: unknown,
	name: string,
	check: (n: number) => boolean,
	rangeText: string,
): Vec3 | string {
	if (!Array.isArray(value) || value.length !== 3) return `${name} must be an array of 3 numbers`;
	for (const n of value) {
		if (typeof n !== 'number' || !Number.isFinite(n)) return `${name} must contain finite numbers`;
		if (!check(n)) return `${name} out of range (${rangeText})`;
	}
	// `+ 0` turns -0 into 0 so the file never contains "-0".
	return [value[0] + 0, value[1] + 0, value[2] + 0];
}

/** Returns the cleaned object (canonical key order, unknown keys dropped) or the reason it is invalid. */
function parseObject(raw: unknown, options: ParseOptions): SceneObject | string {
	if (!isRecord(raw)) return 'not an object';
	const { id, type, color } = raw;
	if (typeof id !== 'string' || !ID_RE.test(id)) return 'id must be 1-64 letters, digits, "_" or "-"';
	if (typeof type !== 'string') return 'type must be a string';

	const modelId = modelIdOf(type);
	if (modelId !== null) {
		if (!ID_RE.test(modelId)) return `invalid model type "${type}"`;
		if (options.modelIds && !options.modelIds.includes(modelId)) return `unknown model "${modelId}"`;
	} else if (!isPrimitiveType(type)) {
		return `unknown type "${type}"`;
	}

	const position = parseVec3(
		raw.position,
		'position',
		(n) => Math.abs(n) <= LIMITS.maxPosition,
		`±${LIMITS.maxPosition}`,
	);
	if (typeof position === 'string') return position;
	const rotation = parseVec3(
		raw.rotation,
		'rotation',
		(n) => Math.abs(n) <= LIMITS.maxRotation,
		`±${LIMITS.maxRotation}`,
	);
	if (typeof rotation === 'string') return rotation;
	const scale = parseVec3(
		raw.scale,
		'scale',
		(n) => n >= LIMITS.minScale && n <= LIMITS.maxScale,
		`${LIMITS.minScale}-${LIMITS.maxScale}`,
	);
	if (typeof scale === 'string') return scale;

	const out: SceneObject = { id, type, position, rotation, scale };
	if (color !== undefined) {
		if (typeof color !== 'string' || !COLOR_RE.test(color)) return 'color must be "#rrggbb"';
		out.color = color.toLowerCase();
	}
	return out;
}

/**
 * Lenient parser used by the build, the public site and /admin. It never throws: anything invalid is
 * dropped and reported in `warnings`. Callers that must refuse bad data (the admin before a commit)
 * check `ok` and `warnings.length === 0`, see validateScene().
 */
export function parseScene(input: unknown, options: ParseOptions = {}): ParseResult {
	const warnings: string[] = [];
	const slugs = options.slugs;
	const scene: SceneData = slugs ? emptyScene(slugs) : { version: SCENE_VERSION, rooms: {} };
	const fail = (message: string): ParseResult => {
		warnings.push(message);
		return { scene, warnings, ok: false };
	};

	if (!isRecord(input)) return fail('scene is not an object');
	if (input.version !== SCENE_VERSION) {
		return fail(`unsupported scene version ${JSON.stringify(input.version)} (expected ${SCENE_VERSION})`);
	}
	if (!isRecord(input.rooms)) return fail('"rooms" must be an object');

	for (const slug of Object.keys(input.rooms)) {
		const known = slugs ? slugs.includes(slug) : SLUG_RE.test(slug);
		if (!known) {
			warnings.push(`room "${slug}": unknown room, dropped`);
			continue;
		}
		const room = input.rooms[slug];
		if (!isRecord(room) || !Array.isArray(room.objects)) {
			warnings.push(`room "${slug}": must be {"objects": [...]}, treated as empty`);
			continue;
		}
		const objects: SceneObject[] = [];
		const seen = new Set<string>();
		let overflow = 0;
		room.objects.forEach((raw: unknown, index: number) => {
			if (objects.length >= LIMITS.maxObjectsPerRoom) {
				overflow++;
				return;
			}
			const result = parseObject(raw, options);
			// Name the object (when it has a readable id/type) so the problem can be found in the editor.
			const who =
				isRecord(raw) && typeof raw.id === 'string' && typeof raw.type === 'string'
					? ` (${raw.type.slice(0, 40)} "${raw.id.slice(0, 40)}")`
					: '';
			const where = `room "${slug}" object #${index}${who}`;
			if (typeof result === 'string') {
				warnings.push(`${where}: ${result}, dropped`);
			} else if (seen.has(result.id)) {
				warnings.push(`${where}: duplicate id "${result.id}", dropped`);
			} else {
				seen.add(result.id);
				objects.push(result);
			}
		});
		if (overflow) {
			warnings.push(`room "${slug}": more than ${LIMITS.maxObjectsPerRoom} objects, ${overflow} dropped`);
		}
		scene.rooms[slug] = { objects };
	}
	return { scene, warnings, ok: true };
}

/** Strict check for "may I commit this?": the problems found, empty when the input is fully valid. */
export function validateScene(input: unknown, options: ParseOptions = {}): string[] {
	return parseScene(input, options).warnings;
}

/** The exact text committed to GitHub: stable key order, 2-space indent, trailing newline. */
export function serializeScene(scene: SceneData): string {
	return JSON.stringify(scene, null, 2) + '\n';
}

export function cloneScene(scene: SceneData): SceneData {
	return JSON.parse(JSON.stringify(scene)) as SceneData;
}

export function roundTo(value: number, digits = 4): number {
	const f = 10 ** digits;
	return Math.round(value * f) / f + 0;
}

export function snapTo(value: number, step: number): number {
	return roundTo(Math.round(value / step) * step);
}

/**
 * How far to shift an object along one axis so that its extent [min, max] lies inside [lo, hi].
 * Returns 0 when it already fits. If it is larger than the range, the low side wins.
 */
export function shiftIntoRange(min: number, max: number, lo: number, hi: number): number {
	if (min < lo) return lo - min;
	if (max > hi) return hi - max;
	return 0;
}

export interface ModelEntry {
	id: string;
	label: string;
	/** Site-root path of the .glb, e.g. "/models/sofa.glb". */
	file: string;
	defaultScale: number;
}

/** Keeps the usable entries of models.json; never throws. Anything else is silently skipped. */
export function parseModels(input: unknown): ModelEntry[] {
	if (!Array.isArray(input)) return [];
	const out: ModelEntry[] = [];
	for (const raw of input) {
		if (!isRecord(raw)) continue;
		const { id, label, file, defaultScale } = raw;
		if (typeof id !== 'string' || !ID_RE.test(id) || out.some((m) => m.id === id)) continue;
		if (typeof label !== 'string' || typeof file !== 'string' || !file.startsWith('/')) continue;
		if (
			typeof defaultScale !== 'number' ||
			!(defaultScale >= LIMITS.minScale && defaultScale <= LIMITS.maxScale)
		) {
			continue;
		}
		out.push({ id, label, file, defaultScale });
	}
	return out;
}
