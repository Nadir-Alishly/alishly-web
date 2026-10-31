// Global scene settings (textures, sun, glow, lights): defaults, ranges, parsing and the sun/key directions.
// Pure TypeScript with only erasable syntax and no DOM/three/Astro imports, so Node can import it directly
// (`node --test`). The defaults ARE today's constants of room-core.ts: a scene without `settings` renders exactly as
// before. Admin-only labels and grouping live in src/scripts/admin/settings-panel.ts.
//
// Storage (scene.json `settings`) is SPARSE: only values that differ from DEFAULT_SETTINGS are written, groups with no
// difference are left out, and the whole key is left out when nothing differs. Why: the committed file does not change
// until someone edits a setting, a code-side default change reaches rooms that never overrode it, and the sun/key
// default angles (derived from SUN_POSITION / KEY_POSITION) stay exact instead of being rounded to 4 decimals.
import { HALO_SPREAD, POOL_SPREAD } from './room-glow.ts';
import { SUN_POSITION } from './room-sun.ts';
import type { Vec3 } from './scene';

export interface FloorSettings {
	/** World units per texture repeat (the floor is 6.4 wide). */
	tile: number;
	/** Degrees, about the middle of the floor. */
	rotation: number;
	/** Fractions of one texture tile. */
	offsetX: number;
	offsetY: number;
	/** Multiplies the oak roughness map. */
	roughness: number;
	/** Image-based light on the floor only. */
	envIntensity: number;
}

export interface WallSettings {
	/** World units per texture repeat. */
	tile: number;
	rotation: number;
	offsetX: number;
	offsetY: number;
	/** Strength of the stucco bump (no effect on touch devices, which skip the normal map). */
	normalScale: number;
}

export interface SunSettings {
	color: string;
	intensity: number;
	/** Degrees from the window wall's outward normal towards the back wall. Clamped to a tested domain. */
	azimuth: number;
	/** Degrees above the horizon. Clamped to a tested domain. */
	elevation: number;
	shadowRadius: number;
}

export interface GlowSettings {
	color: string;
	haloOpacity: number;
	haloSpread: number;
	poolOpacity: number;
	poolSpread: number;
}

export interface KeySettings {
	color: string;
	intensity: number;
	/** Degrees round the room, 0 = straight in front of the open side (+z), positive towards +x. */
	azimuth: number;
	elevation: number;
	shadowRadius: number;
}

export interface FillSettings {
	/** Hemisphere light: sky colour from above, ground colour bounced from below. */
	sky: string;
	ground: string;
	intensity: number;
	/** Image-based ambient light. */
	envIntensity: number;
	/** Tone-mapping exposure. The window glow is not tone mapped, so exposure does not dim it. */
	exposure: number;
}

export interface ShadowSettings {
	bias: number;
	normalBias: number;
}

export interface SceneSettings {
	floor: FloorSettings;
	wall: WallSettings;
	sun: SunSettings;
	glow: GlowSettings;
	key: KeySettings;
	fill: FillSettings;
	shadows: ShadowSettings;
}

export type SettingsGroup = keyof SceneSettings;
export const SETTINGS_GROUPS: readonly SettingsGroup[] = ['floor', 'wall', 'sun', 'glow', 'key', 'fill', 'shadows'];

const DEG = Math.PI / 180;

/** The key light's position (it aims at the origin). Its distance stays fixed; only the angles are settings. */
export const KEY_POSITION: Vec3 = [4.5, 9, 8];
export const SUN_DISTANCE = Math.hypot(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
export const KEY_DISTANCE = Math.hypot(KEY_POSITION[0], KEY_POSITION[1], KEY_POSITION[2]);

// Default angles are derived (not typed in) so that sunDirection()/keyDirection() give back SUN_POSITION / KEY_POSITION.
const DEFAULT_SUN_AZIMUTH = Math.atan2(-SUN_POSITION[2], -SUN_POSITION[0]) / DEG;
const DEFAULT_SUN_ELEVATION = Math.atan2(SUN_POSITION[1], Math.hypot(SUN_POSITION[0], SUN_POSITION[2])) / DEG;
const DEFAULT_KEY_AZIMUTH = Math.atan2(KEY_POSITION[0], KEY_POSITION[2]) / DEG;
const DEFAULT_KEY_ELEVATION = Math.asin(KEY_POSITION[1] / KEY_DISTANCE) / DEG;

/** Today's look. Never mutate it: use cloneSettings(). */
export const DEFAULT_SETTINGS: SceneSettings = {
	floor: { tile: 3.2, rotation: 0, offsetX: 0, offsetY: 0, roughness: 1.1, envIntensity: 0.35 },
	wall: { tile: 8, rotation: 0, offsetX: 0, offsetY: 0, normalScale: 2 },
	sun: {
		color: '#ffe2b8',
		intensity: 5.2,
		azimuth: DEFAULT_SUN_AZIMUTH,
		elevation: DEFAULT_SUN_ELEVATION,
		shadowRadius: 4,
	},
	glow: { color: '#ffd9a6', haloOpacity: 0.75, haloSpread: HALO_SPREAD, poolOpacity: 0.14, poolSpread: POOL_SPREAD },
	key: {
		color: '#fff0d9',
		intensity: 1.8,
		azimuth: DEFAULT_KEY_AZIMUTH,
		elevation: DEFAULT_KEY_ELEVATION,
		shadowRadius: 4,
	},
	fill: { sky: '#e6efff', ground: '#d9cbb8', intensity: 0.6, envIntensity: 0.2, exposure: 1 },
	shadows: { bias: -0.0004, normalBias: 0.03 },
};

export interface Range {
	min: number;
	max: number;
}

/**
 * Allowed range of every numeric setting. The sun's azimuth/elevation range is the tested domain in which sunlight
 * enters ONLY through the window (see sunBlockerFor in room-sun.ts and tasks/2026-10-31-scene-settings/sun-domain.mts);
 * widening it needs that sweep to be re-run. The shadow radius stops at 6 because PCF uses 5 taps and turns into grain.
 */
export const SETTING_RANGES: Record<SettingsGroup, Record<string, Range>> = {
	floor: {
		tile: { min: 0.8, max: 12.8 },
		rotation: { min: -180, max: 180 },
		offsetX: { min: -1, max: 1 },
		offsetY: { min: -1, max: 1 },
		roughness: { min: 0, max: 1.3 }, // three clamps roughness at 1 and the map's mean is 0.44: above ~1.3 nothing changes
		envIntensity: { min: 0, max: 2 },
	},
	wall: {
		tile: { min: 1, max: 32 },
		rotation: { min: -180, max: 180 },
		offsetX: { min: -1, max: 1 },
		offsetY: { min: -1, max: 1 },
		normalScale: { min: 0, max: 6 },
	},
	sun: {
		intensity: { min: 0, max: 15 },
		azimuth: { min: 0, max: 30 },
		elevation: { min: 15, max: 40 },
		shadowRadius: { min: 0, max: 6 },
	},
	glow: {
		haloOpacity: { min: 0, max: 1 },
		haloSpread: { min: 0.2, max: 3 },
		poolOpacity: { min: 0, max: 0.5 },
		poolSpread: { min: 0.1, max: 2 },
	},
	key: {
		intensity: { min: 0, max: 6 },
		azimuth: { min: -90, max: 90 },
		elevation: { min: 25, max: 85 },
		shadowRadius: { min: 0, max: 6 },
	},
	fill: {
		intensity: { min: 0, max: 3 },
		envIntensity: { min: 0, max: 1.5 },
		exposure: { min: 0.3, max: 2 },
	},
	shadows: {
		bias: { min: -0.005, max: 0.005 },
		normalBias: { min: 0, max: 0.2 },
	},
};

/** `#rrggbb`: the one colour format of scene.json (settings, objects, wall colours). */
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

type Flat = Record<string, Record<string, number | string>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const round4 = (value: number) => Math.round(value * 1e4) / 1e4 + 0;

export function cloneSettings(settings: SceneSettings): SceneSettings {
	return JSON.parse(JSON.stringify(settings)) as SceneSettings;
}

export interface SettingsResult {
	/** Always complete and in range. */
	settings: SceneSettings;
	/** One line per problem; empty means the input was fully valid (a missing `settings` is valid). */
	warnings: string[];
}

/**
 * Lenient parser, never throws. Missing = defaults. A wrong type or a bad colour falls back to the default, an
 * out-of-range number is clamped, both with a warning; unknown groups and keys are dropped silently (like the scene
 * parser does). Numbers are rounded to 4 decimals, except a value equal to its default, which stays exact.
 */
export function parseSettings(raw: unknown): SettingsResult {
	const settings = cloneSettings(DEFAULT_SETTINGS);
	const warnings: string[] = [];
	if (raw === undefined) return { settings, warnings };
	if (!isRecord(raw)) {
		warnings.push('settings must be an object, defaults used');
		return { settings, warnings };
	}
	const out = settings as unknown as Flat;
	const defaults = DEFAULT_SETTINGS as unknown as Flat;
	for (const group of SETTINGS_GROUPS) {
		const rawGroup = raw[group];
		if (rawGroup === undefined) continue;
		if (!isRecord(rawGroup)) {
			warnings.push(`settings.${group} must be an object, defaults used`);
			continue;
		}
		for (const key of Object.keys(defaults[group])) {
			const value = rawGroup[key];
			if (value === undefined) continue;
			const where = `settings.${group}.${key}`;
			const def = defaults[group][key];
			if (typeof def === 'string') {
				if (typeof value === 'string' && COLOR_RE.test(value)) out[group][key] = value.toLowerCase();
				else warnings.push(`${where} must be "#rrggbb", default used`);
				continue;
			}
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				warnings.push(`${where} must be a finite number, default used`);
				continue;
			}
			const { min, max } = SETTING_RANGES[group][key];
			const clamped = Math.min(max, Math.max(min, value));
			if (clamped !== value) warnings.push(`${where}: ${value} is out of range (${min} to ${max}), clamped`);
			out[group][key] = clamped === def ? def : round4(clamped);
		}
	}
	return { settings, warnings };
}

/**
 * Only what differs from the defaults, in canonical order (group order of DEFAULT_SETTINGS), or undefined when nothing
 * differs. This is what scene.json stores.
 */
export function sparseSettings(settings: SceneSettings): Partial<Record<SettingsGroup, Record<string, number | string>>> | undefined {
	const source = settings as unknown as Flat;
	const defaults = DEFAULT_SETTINGS as unknown as Flat;
	const out: Partial<Record<SettingsGroup, Record<string, number | string>>> = {};
	let any = false;
	for (const group of SETTINGS_GROUPS) {
		const diff: Record<string, number | string> = {};
		for (const key of Object.keys(defaults[group])) {
			const value = source[group]?.[key];
			if (value !== undefined && value !== defaults[group][key]) diff[key] = value;
		}
		if (Object.keys(diff).length) {
			out[group] = diff;
			any = true;
		}
	}
	return any ? out : undefined;
}

export function settingsEqual(a: SceneSettings, b: SceneSettings): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

const clampTo = (value: number, range: Range) => Math.min(range.max, Math.max(range.min, value));

/**
 * The sun's position (it aims at the origin, at a fixed distance) from an azimuth (degrees from the window wall's
 * outward normal, positive towards the back wall) and an elevation (degrees). Both are clamped to SETTING_RANGES.sun,
 * the domain in which sunlight enters only through the window; z is never positive.
 */
export function sunDirection(azimuth: number, elevation: number): Vec3 {
	const az = clampTo(azimuth, SETTING_RANGES.sun.azimuth) * DEG;
	const el = clampTo(elevation, SETTING_RANGES.sun.elevation) * DEG;
	return [
		-SUN_DISTANCE * Math.cos(el) * Math.cos(az),
		SUN_DISTANCE * Math.sin(el),
		-SUN_DISTANCE * Math.cos(el) * Math.sin(az),
	];
}

/** The key light's position from an azimuth (0 = from +z, positive towards +x) and elevation, at the fixed distance. */
export function keyDirection(azimuth: number, elevation: number): Vec3 {
	const az = clampTo(azimuth, SETTING_RANGES.key.azimuth) * DEG;
	const el = clampTo(elevation, SETTING_RANGES.key.elevation) * DEG;
	return [
		KEY_DISTANCE * Math.cos(el) * Math.sin(az),
		KEY_DISTANCE * Math.sin(el),
		KEY_DISTANCE * Math.cos(el) * Math.cos(az),
	];
}
