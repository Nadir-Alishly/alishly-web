// Unit tests for src/data/scene-settings.ts (global scene settings), their storage in scene.ts (sparse `settings`,
// per-room `wallColor`) and src/data/effective-colors.ts. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	DEFAULT_SETTINGS, SETTING_RANGES, SETTINGS_GROUPS, KEY_POSITION, parseSettings, sparseSettings, cloneSettings,
	settingsEqual, sunDirection, keyDirection, COLOR_RE,
} from '../src/data/scene-settings.ts';
import type { SceneSettings } from '../src/data/scene-settings.ts';
import { SUN_POSITION } from '../src/data/room-sun.ts';
import { HALO_SPREAD, POOL_SPREAD } from '../src/data/room-glow.ts';
import { parseScene, validateScene, serializeScene, emptyScene, cloneScene } from '../src/data/scene.ts';
import { effectiveColors, colorsForWall } from '../src/data/effective-colors.ts';
import { family } from '../src/data/family.ts';
import { floorOf } from '../src/data/room-palette.ts';

const SLUGS = family.map((m) => m.slug);
const opts = { slugs: SLUGS, modelIds: ['crate'] };
type Flat = Record<string, Record<string, number | string>>;
const flat = (s: unknown) => s as Flat;
const numericKeys = (): [string, string][] =>
	SETTINGS_GROUPS.flatMap((g) => Object.entries(flat(DEFAULT_SETTINGS)[g]).filter(([, v]) => typeof v === 'number').map(([k]): [string, string] => [g, k]));
const colorKeys = (): [string, string][] =>
	SETTINGS_GROUPS.flatMap((g) => Object.entries(flat(DEFAULT_SETTINGS)[g]).filter(([, v]) => typeof v === 'string').map(([k]): [string, string] => [g, k]));
const near = (a: number[], b: number[], eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

// ---------------------------------------------------------------------------------------------------------------
// defaults and ranges
// ---------------------------------------------------------------------------------------------------------------

test('DEFAULT_SETTINGS equals today\'s hard-coded look (constants of the old room-core.ts)', () => {
	const d = DEFAULT_SETTINGS;
	assert.deepEqual(d.floor, { tile: 3.2, rotation: 0, offsetX: 0, offsetY: 0, roughness: 1.1, envIntensity: 0.35 });
	assert.deepEqual(d.wall, { tile: 8, rotation: 0, offsetX: 0, offsetY: 0, normalScale: 2 });
	assert.deepEqual(d.window, { tile: 0.8, rotation: 0, offsetX: 0, offsetY: 0, color: '#ffffff' });
	assert.equal(d.sun.color, '#ffe2b8');
	assert.equal(d.sun.intensity, 5.2);
	assert.equal(d.sun.shadowRadius, 4);
	assert.deepEqual(d.glow, { color: '#ffd9a6', haloOpacity: 0.75, haloSpread: HALO_SPREAD, poolOpacity: 0.14, poolSpread: POOL_SPREAD });
	assert.equal(d.key.color, '#fff0d9');
	assert.equal(d.key.intensity, 1.8);
	assert.equal(d.key.shadowRadius, 4);
	assert.deepEqual(d.fill, { sky: '#e6efff', ground: '#d9cbb8', intensity: 0.6, envIntensity: 0.2, exposure: 1 });
	assert.deepEqual(d.shadows, { bias: -0.0004, normalBias: 0.03 });
});

test('default sun and key angles give back SUN_POSITION / KEY_POSITION', () => {
	const sun = sunDirection(DEFAULT_SETTINGS.sun.azimuth, DEFAULT_SETTINGS.sun.elevation);
	assert.ok(near(sun, SUN_POSITION), `sun ${sun} vs ${SUN_POSITION}`);
	const key = keyDirection(DEFAULT_SETTINGS.key.azimuth, DEFAULT_SETTINGS.key.elevation);
	assert.ok(near(key, KEY_POSITION), `key ${key} vs ${KEY_POSITION}`);
});

test('every default sits inside its range, every numeric setting has a range and every range has a setting', () => {
	for (const [g, k] of numericKeys()) {
		const r = SETTING_RANGES[g as keyof SceneSettings]?.[k];
		assert.ok(r, `${g}.${k} has a range`);
		assert.ok(r.min < r.max, `${g}.${k} range is ordered`);
		const v = flat(DEFAULT_SETTINGS)[g][k] as number;
		assert.ok(v >= r.min && v <= r.max, `${g}.${k} default ${v} within ${r.min}..${r.max}`);
	}
	const numeric = new Set(numericKeys().map(([g, k]) => `${g}.${k}`));
	for (const g of SETTINGS_GROUPS) for (const k of Object.keys(SETTING_RANGES[g])) assert.ok(numeric.has(`${g}.${k}`), `range ${g}.${k} belongs to a numeric setting`);
	for (const [g, k] of colorKeys()) assert.match(String(flat(DEFAULT_SETTINGS)[g][k]), /^#[0-9a-f]{6}$/, `${g}.${k} default colour`);
	assert.deepEqual(SETTINGS_GROUPS, ['floor', 'wall', 'window', 'sun', 'glow', 'key', 'fill', 'objects', 'ao', 'shadows']);
	assert.deepEqual(Object.keys(DEFAULT_SETTINGS), [...SETTINGS_GROUPS], 'group order is canonical');
});

test('the sun range is the tested domain az 0..30, el 15..40; shadow softness stops at 6', () => {
	assert.deepEqual(SETTING_RANGES.sun.azimuth, { min: 0, max: 30 });
	assert.deepEqual(SETTING_RANGES.sun.elevation, { min: 15, max: 40 });
	assert.equal(SETTING_RANGES.sun.shadowRadius.max, 6);
	assert.equal(SETTING_RANGES.key.shadowRadius.max, 6);
});

// ---------------------------------------------------------------------------------------------------------------
// parseSettings
// ---------------------------------------------------------------------------------------------------------------

test('parseSettings: missing / empty input = the defaults, no warnings, a fresh copy', () => {
	for (const raw of [undefined, {}, { floor: {} }, { sun: {}, wall: {} }]) {
		const r = parseSettings(raw);
		assert.deepEqual(r.warnings, [], JSON.stringify(raw));
		assert.deepEqual(r.settings, DEFAULT_SETTINGS);
		assert.notEqual(r.settings, DEFAULT_SETTINGS);
		assert.notEqual(r.settings.sun, DEFAULT_SETTINGS.sun);
	}
	const r = parseSettings(undefined);
	r.settings.sun.intensity = 99;
	assert.equal(DEFAULT_SETTINGS.sun.intensity, 5.2, 'mutating a result never touches the defaults');
});

test('parseSettings: valid values are kept (and rounded to 4 decimals)', () => {
	const r = parseSettings({ floor: { tile: 4, rotation: 45.123456, offsetX: 0.25 }, sun: { intensity: 8, color: '#112233' }, shadows: { bias: -0.001 } });
	assert.deepEqual(r.warnings, []);
	assert.equal(r.settings.floor.tile, 4);
	assert.equal(r.settings.floor.rotation, 45.1235);
	assert.equal(r.settings.floor.offsetX, 0.25);
	assert.equal(r.settings.floor.offsetY, 0, 'untouched keys keep their default');
	assert.equal(r.settings.sun.intensity, 8);
	assert.equal(r.settings.sun.color, '#112233');
	assert.equal(r.settings.shadows.bias, -0.001);
	assert.equal(r.settings.shadows.normalBias, DEFAULT_SETTINGS.shadows.normalBias);
});

test('parseSettings: rounding via roundTo(…,4), and no negative zero', () => {
	const r = parseSettings({ floor: { offsetX: -0.00001, offsetY: 0.00004, rotation: 1.00005 }, wall: { tile: 8.00004 } });
	assert.ok(Object.is(r.settings.floor.offsetX, 0), 'tiny negative rounds to +0, not -0');
	assert.equal(r.settings.floor.offsetY, 0);
	assert.equal(r.settings.floor.rotation, 1.0001);
	assert.equal(r.settings.wall.tile, 8, 'rounds onto the default value');
	assert.deepEqual(r.warnings, []);
});

test('parseSettings: a value equal to its default stays EXACT (sun/key default angles are not rounded)', () => {
	const sun = DEFAULT_SETTINGS.sun;
	assert.notEqual(sun.azimuth, Math.round(sun.azimuth * 1e4) / 1e4, 'default azimuth really has more than 4 decimals');
	const r = parseSettings({ sun: { azimuth: sun.azimuth, elevation: sun.elevation }, key: { azimuth: DEFAULT_SETTINGS.key.azimuth } });
	assert.equal(r.settings.sun.azimuth, sun.azimuth);
	assert.equal(r.settings.sun.elevation, sun.elevation);
	assert.equal(r.settings.key.azimuth, DEFAULT_SETTINGS.key.azimuth);
	assert.equal(sparseSettings(r.settings), undefined, 'so it is not stored');
	// a typed value one rounding step away IS stored
	const near5 = parseSettings({ sun: { azimuth: 5.0794 } });
	assert.equal(near5.settings.sun.azimuth, 5.0794);
	assert.deepEqual(sparseSettings(near5.settings), { sun: { azimuth: 5.0794 } });
});

test('parseSettings: out-of-range numbers are clamped with one warning each naming the setting', () => {
	for (const [g, k] of numericKeys()) {
		const { min, max } = SETTING_RANGES[g as keyof SceneSettings][k];
		const hi = parseSettings({ [g]: { [k]: max + 1000 } });
		assert.equal(flat(hi.settings)[g][k], max, `${g}.${k} high clamps to ${max}`);
		assert.equal(hi.warnings.length, 1, `${g}.${k} high: one warning`);
		assert.ok(hi.warnings[0].includes(`settings.${g}.${k}`), hi.warnings[0]);
		const lo = parseSettings({ [g]: { [k]: min - 1000 } });
		assert.equal(flat(lo.settings)[g][k], min, `${g}.${k} low clamps to ${min}`);
		assert.equal(lo.warnings.length, 1);
		// exactly the boundary values are fine
		for (const edge of [min, max]) {
			const e = parseSettings({ [g]: { [k]: edge } });
			assert.deepEqual(e.warnings, [], `${g}.${k}=${edge} is valid`);
			assert.equal(flat(e.settings)[g][k], edge);
		}
	}
});

test('parseSettings: the sun is clamped to the tested domain, and shadow radius to 0..6', () => {
	const r = parseSettings({ sun: { azimuth: 90, elevation: 5, shadowRadius: 100 }, key: { shadowRadius: -3 } });
	assert.equal(r.settings.sun.azimuth, 30);
	assert.equal(r.settings.sun.elevation, 15);
	assert.equal(r.settings.sun.shadowRadius, 6);
	assert.equal(r.settings.key.shadowRadius, 0);
	assert.equal(r.warnings.length, 4);
});

test('parseSettings: wrong types and non-finite numbers fall back to the default with a warning', () => {
	const bad = [ '3', null, true, [], {}, NaN, Infinity, -Infinity ];
	for (const v of bad) {
		const r = parseSettings({ floor: { tile: v } });
		assert.equal(r.settings.floor.tile, DEFAULT_SETTINGS.floor.tile, String(v));
		assert.equal(r.warnings.length, 1, `${String(v)}: ${r.warnings.join('|')}`);
		assert.ok(r.warnings[0].includes('settings.floor.tile'));
	}
});

test('parseSettings: bad colours fall back to the default with a warning; good ones are lower-cased', () => {
	for (const v of ['red', '#fff', '#12345', '#1234567', '#GGGGGG', 'ffe2b8', '', 123, null, ['#ffffff']]) {
		const r = parseSettings({ sun: { color: v } });
		assert.equal(r.settings.sun.color, DEFAULT_SETTINGS.sun.color, JSON.stringify(v));
		assert.equal(r.warnings.length, 1, JSON.stringify(v));
		assert.ok(r.warnings[0].includes('settings.sun.color'));
	}
	const ok = parseSettings({ sun: { color: '#FFAA00' }, glow: { color: '#aAbBcC' }, fill: { sky: '#000000', ground: '#FFFFFF' } });
	assert.deepEqual(ok.warnings, []);
	assert.equal(ok.settings.sun.color, '#ffaa00');
	assert.equal(ok.settings.glow.color, '#aabbcc');
	assert.equal(ok.settings.fill.ground, '#ffffff');
});

test('parseSettings: unknown groups and keys are stripped silently (and never reach the result)', () => {
	const r = parseSettings({ floor: { tile: 4, bogus: 1, __proto__: { evil: 1 } }, nonsense: { a: 1 }, sun: { intensity: 3, extra: 'x' }, constructor: 5 });
	assert.deepEqual(r.warnings, []);
	assert.equal(r.settings.floor.tile, 4);
	assert.deepEqual(Object.keys(r.settings), [...SETTINGS_GROUPS]);
	assert.deepEqual(Object.keys(r.settings.floor), Object.keys(DEFAULT_SETTINGS.floor));
	assert.deepEqual(Object.keys(r.settings.sun), Object.keys(DEFAULT_SETTINGS.sun));
	assert.equal(({} as Record<string, unknown>).evil, undefined, 'no prototype pollution');
});

test('parseSettings: non-object settings / groups give defaults plus a warning, and it never throws', () => {
	for (const raw of [null, 5, 'x', true, [], [1, 2]]) {
		const r = parseSettings(raw);
		assert.deepEqual(r.settings, DEFAULT_SETTINGS, JSON.stringify(raw));
		assert.equal(r.warnings.length, 1, JSON.stringify(raw));
	}
	for (const g of ['floor', 'sun', 'shadows']) {
		for (const v of [null, 5, 'x', []]) {
			const r = parseSettings({ [g]: v });
			assert.deepEqual(r.settings, DEFAULT_SETTINGS);
			assert.equal(r.warnings.length, 1, `${g}=${JSON.stringify(v)}`);
			assert.ok(r.warnings[0].includes(`settings.${g}`));
		}
	}
	assert.doesNotThrow(() => parseSettings(Symbol.iterator as unknown));
	assert.doesNotThrow(() => parseSettings(() => 1));
});

test('parseSettings: idempotent (parse of a parsed result is identical, with no warnings)', () => {
	const messy = { floor: { tile: 99, rotation: 12.34567, offsetX: -5 }, sun: { azimuth: 17.123456, elevation: 99, color: '#ABCDEF' }, glow: { haloSpread: 0 }, shadows: { bias: 0.123 } };
	const a = parseSettings(messy);
	assert.ok(a.warnings.length > 0);
	const b = parseSettings(a.settings);
	assert.deepEqual(b.warnings, []);
	assert.deepEqual(b.settings, a.settings);
});

test('settingsEqual / cloneSettings', () => {
	const c = cloneSettings(DEFAULT_SETTINGS);
	assert.ok(settingsEqual(c, DEFAULT_SETTINGS));
	c.floor.tile = 5;
	assert.ok(!settingsEqual(c, DEFAULT_SETTINGS));
	assert.equal(DEFAULT_SETTINGS.floor.tile, 3.2, 'clone is deep');
});

// ---------------------------------------------------------------------------------------------------------------
// sparse storage
// ---------------------------------------------------------------------------------------------------------------

test('sparseSettings: nothing differs = undefined; only differences, in canonical group/key order, empty groups omitted', () => {
	assert.equal(sparseSettings(DEFAULT_SETTINGS), undefined);
	assert.equal(sparseSettings(cloneSettings(DEFAULT_SETTINGS)), undefined);
	const s = cloneSettings(DEFAULT_SETTINGS);
	s.shadows.bias = 0.001; // set out of canonical order on purpose
	s.floor.rotation = 30;
	s.floor.tile = 4;
	s.sun.color = '#ff0000';
	const sparse = sparseSettings(s)!;
	assert.deepEqual(sparse, { floor: { tile: 4, rotation: 30 }, sun: { color: '#ff0000' }, shadows: { bias: 0.001 } });
	assert.deepEqual(Object.keys(sparse), ['floor', 'sun', 'shadows']);
	assert.deepEqual(Object.keys(sparse.floor!), ['tile', 'rotation'], 'key order follows the defaults');
	assert.ok(!('wall' in sparse) && !('glow' in sparse));
});

test('sparse round trip: parseSettings(sparseSettings(x)) === x for varied and extreme settings, with no warnings', () => {
	const samples: SceneSettings[] = [];
	const lo = cloneSettings(DEFAULT_SETTINGS), hi = cloneSettings(DEFAULT_SETTINGS), mid = cloneSettings(DEFAULT_SETTINGS);
	for (const [g, k] of numericKeys()) {
		const { min, max } = SETTING_RANGES[g as keyof SceneSettings][k];
		flat(lo)[g][k] = min; flat(hi)[g][k] = max; flat(mid)[g][k] = Math.round(((min + max) / 2) * 1e4) / 1e4;
	}
	for (const [g, k] of colorKeys()) { flat(lo)[g][k] = '#000000'; flat(hi)[g][k] = '#ffffff'; flat(mid)[g][k] = '#123abc'; }
	samples.push(lo, hi, mid, cloneSettings(DEFAULT_SETTINGS));
	for (const s of samples) {
		const back = parseSettings(sparseSettings(s));
		assert.deepEqual(back.warnings, []);
		assert.deepEqual(back.settings, s);
	}
});

// ---------------------------------------------------------------------------------------------------------------
// window settings (the admin's "Window wood" group: the frame, sill and muntins' dark-wood texture and tint)
// ---------------------------------------------------------------------------------------------------------------

test('window: ranges match the floor/wall pattern (tile 0.1..4 m, turn ±180°, offsets ±1 tile); the tint is a colour', () => {
	assert.deepEqual(SETTING_RANGES.window, {
		tile: { min: 0.1, max: 4 },
		rotation: { min: -180, max: 180 },
		offsetX: { min: -1, max: 1 },
		offsetY: { min: -1, max: 1 },
	});
	assert.match(DEFAULT_SETTINGS.window.color, COLOR_RE);
});

test('window: parse keeps in-range values, clamps out-of-range numbers with a warning, lower-cases the tint', () => {
	const r = parseSettings({ window: { tile: 2.5, rotation: 400, offsetX: -5, offsetY: 0.25, color: '#ABCDEF' } });
	assert.deepEqual(r.settings.window, { tile: 2.5, rotation: 180, offsetX: -1, offsetY: 0.25, color: '#abcdef' });
	assert.equal(r.warnings.length, 2, JSON.stringify(r.warnings));
	assert.ok(r.warnings.some((w) => w.includes('settings.window.rotation')), 'rotation clamped');
	assert.ok(r.warnings.some((w) => w.includes('settings.window.offsetX')), 'offsetX clamped');
});

test('window: a bad tint or a non-number falls back to the default with a warning; tile 0 clamps to 0.1 (never a zero repeat)', () => {
	const bad = parseSettings({ window: { color: 'red', tile: 'big' } });
	assert.deepEqual(bad.settings.window, DEFAULT_SETTINGS.window);
	assert.equal(bad.warnings.length, 2, JSON.stringify(bad.warnings));
	assert.ok(bad.warnings.some((w) => w.includes('settings.window.color')));
	assert.ok(bad.warnings.some((w) => w.includes('settings.window.tile')));
	const zero = parseSettings({ window: { tile: 0 } });
	assert.equal(zero.settings.window.tile, 0.1);
	assert.equal(zero.warnings.length, 1);
});

test('window: unknown window keys are dropped silently and the window keys keep their canonical order', () => {
	const r = parseSettings({ window: { bogus: 1, color: '#123456', tile: 1.5 } });
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(Object.keys(r.settings.window), Object.keys(DEFAULT_SETTINGS.window));
	assert.equal(r.settings.window.tile, 1.5);
});

test('window: sparse storage keeps only the window keys that differ; an untouched window stores nothing', () => {
	const s = cloneSettings(DEFAULT_SETTINGS);
	s.window.tile = 2;
	s.window.color = '#808080';
	const sparse = sparseSettings(s)!;
	assert.deepEqual(sparse, { window: { tile: 2, color: '#808080' } });
	assert.deepEqual(Object.keys(sparse.window!), ['tile', 'color'], 'key order follows the defaults');
	const same = cloneSettings(DEFAULT_SETTINGS);
	same.window.rotation = 0;
	assert.equal(sparseSettings(same), undefined, 'a default window adds nothing to scene.json');
});

test('window: the sparse window round trip is exact at both range ends, with no warnings; group order is floor, wall, window, sun…', () => {
	const s = cloneSettings(DEFAULT_SETTINGS);
	s.window = { tile: 0.1, rotation: -180, offsetX: 1, offsetY: -1, color: '#000000' };
	const sparse = sparseSettings(s)!;
	assert.deepEqual(Object.keys(sparse), ['window']);
	const back = parseSettings({ window: sparse.window });
	assert.deepEqual(back.warnings, []);
	assert.deepEqual(back.settings.window, s.window);
	assert.deepEqual(Object.keys(DEFAULT_SETTINGS), ['floor', 'wall', 'window', 'sun', 'glow', 'key', 'fill', 'objects', 'ao', 'shadows']);
});

// ---------------------------------------------------------------------------------------------------------------
// objects: the models' own light (envIntensity, aoIntensity)
// ---------------------------------------------------------------------------------------------------------------

test('objects: defaults are envIntensity 1.2 and aoIntensity 1 (as authored); ranges are 0..3 and 0..1', () => {
	assert.deepEqual(DEFAULT_SETTINGS.objects, { envIntensity: 1.2, aoIntensity: 1 });
	assert.deepEqual(Object.keys(DEFAULT_SETTINGS.objects), ['envIntensity', 'aoIntensity']);
	assert.deepEqual(SETTING_RANGES.objects.envIntensity, { min: 0, max: 3 });
	assert.deepEqual(SETTING_RANGES.objects.aoIntensity, { min: 0, max: 1 });
});

test('objects: out-of-range values clamp to 0..3 / 0..1 with one warning each; in-range values are kept', () => {
	const high = parseSettings({ objects: { envIntensity: 5, aoIntensity: 4 } });
	assert.equal(high.settings.objects.envIntensity, 3);
	assert.equal(high.settings.objects.aoIntensity, 1);
	assert.equal(high.warnings.length, 2, high.warnings.join(' | '));
	assert.ok(high.warnings.some((w) => w.includes('settings.objects.envIntensity')), high.warnings.join(' | '));
	assert.ok(high.warnings.some((w) => w.includes('settings.objects.aoIntensity')), high.warnings.join(' | '));
	const low = parseSettings({ objects: { envIntensity: -1, aoIntensity: -0.5 } });
	assert.deepEqual(low.settings.objects, { envIntensity: 0, aoIntensity: 0 });
	const ok = parseSettings({ objects: { envIntensity: 2.25, aoIntensity: 0.5 } });
	assert.deepEqual(ok.settings.objects, { envIntensity: 2.25, aoIntensity: 0.5 });
	assert.deepEqual(ok.warnings, []);
});

test('objects: sparse storage — defaults store nothing; changed values store only their key and round-trip exactly at the range ends', () => {
	assert.equal(sparseSettings(cloneSettings(DEFAULT_SETTINGS))?.objects, undefined, 'default objects add nothing to scene.json');
	for (const [envIntensity, aoIntensity] of [[0, 1], [3, 1], [1.2, 0], [1.2, 1], [0, 0]] as const) {
		const s = cloneSettings(DEFAULT_SETTINGS);
		s.objects = { envIntensity, aoIntensity };
		const sparse = sparseSettings(s) ?? {};
		const expected: Record<string, number> = {};
		if (envIntensity !== DEFAULT_SETTINGS.objects.envIntensity) expected.envIntensity = envIntensity;
		if (aoIntensity !== DEFAULT_SETTINGS.objects.aoIntensity) expected.aoIntensity = aoIntensity;
		assert.deepEqual(sparse.objects ?? {}, expected, `stored keys for ${envIntensity}/${aoIntensity}`);
		const back = parseSettings(JSON.parse(JSON.stringify(sparse)));
		assert.deepEqual(back.warnings, []);
		assert.deepEqual(back.settings.objects, s.objects, `round trip ${envIntensity}/${aoIntensity}`);
	}
});

test('ao: defaults are intensity 0.5 and radius 0.5 m; ranges are 0..1 and 0.05..2 m; the group is ordered after objects', () => {
	assert.deepEqual(DEFAULT_SETTINGS.ao, { intensity: 0.5, radius: 0.5 });
	assert.deepEqual(Object.keys(DEFAULT_SETTINGS.ao), ['intensity', 'radius']);
	assert.deepEqual(SETTING_RANGES.ao.intensity, { min: 0, max: 1 });
	assert.deepEqual(SETTING_RANGES.ao.radius, { min: 0.05, max: 2 });
	assert.ok(SETTINGS_GROUPS.indexOf('ao') > SETTINGS_GROUPS.indexOf('objects'));
	assert.ok(SETTINGS_GROUPS.indexOf('ao') < SETTINGS_GROUPS.indexOf('shadows'));
});

test('ao: out-of-range values clamp (intensity 0..1, radius 0.05..2) with one warning each; in-range values are kept', () => {
	const high = parseSettings({ ao: { intensity: 3, radius: 9 } });
	assert.deepEqual(high.settings.ao, { intensity: 1, radius: 2 });
	assert.equal(high.warnings.length, 2, high.warnings.join(' | '));
	const low = parseSettings({ ao: { intensity: -1, radius: 0 } });
	assert.deepEqual(low.settings.ao, { intensity: 0, radius: 0.05 });
	const ok = parseSettings({ ao: { intensity: 0, radius: 1.25 } });
	assert.deepEqual(ok.settings.ao, { intensity: 0, radius: 1.25 });
	assert.deepEqual(ok.warnings, []);
});

test('ao: sparse storage — defaults store nothing; a changed value stores only its key and round-trips exactly at the range ends', () => {
	assert.equal(sparseSettings(cloneSettings(DEFAULT_SETTINGS))?.ao, undefined, 'default ao adds nothing to scene.json');
	for (const [intensity, radius] of [[0, 0.5], [1, 0.5], [0.5, 0.05], [0.5, 2], [0, 2]] as const) {
		const s = cloneSettings(DEFAULT_SETTINGS);
		s.ao = { intensity, radius };
		const sparse = sparseSettings(s) ?? {};
		const expected: Record<string, number> = {};
		if (intensity !== DEFAULT_SETTINGS.ao.intensity) expected.intensity = intensity;
		if (radius !== DEFAULT_SETTINGS.ao.radius) expected.radius = radius;
		assert.deepEqual(sparse.ao ?? {}, expected, `stored keys for ${intensity}/${radius}`);
		const back = parseSettings(JSON.parse(JSON.stringify(sparse)));
		assert.deepEqual(back.warnings, []);
		assert.deepEqual(back.settings.ao, s.ao, `round trip ${intensity}/${radius}`);
	}
});

test('committed src/data/scene.json: parses with no warnings and stores no objects settings (defaults stay out of the file)', () => {
	const text = readFileSync(new URL('../src/data/scene.json', import.meta.url), 'utf8');
	const parsed = JSON.parse(text) as { settings?: Record<string, unknown> };
	assert.equal(parsed.settings?.objects, undefined, 'the default objects settings are not written to scene.json');
	const modelIds = (JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8')) as { id: string }[]).map((m) => m.id);
	const r = parseScene(parsed, { slugs: SLUGS, modelIds });
	assert.deepEqual(r.warnings, [], r.warnings.join(' | '));
});

// ---------------------------------------------------------------------------------------------------------------
// sunDirection / keyDirection
// ---------------------------------------------------------------------------------------------------------------

test('sunDirection: fixed distance, always outside the left wall, above the floor, z <= 0, clamped to the domain', () => {
	const dist = Math.hypot(...SUN_POSITION);
	for (let az = -10; az <= 50; az += 2.5) for (let el = -10; el <= 60; el += 2.5) {
		const [x, y, z] = sunDirection(az, el);
		assert.ok(Math.abs(Math.hypot(x, y, z) - dist) < 1e-9);
		assert.ok(x < 0 && y > 0 && z <= 1e-12, `az ${az} el ${el}: ${[x, y, z]}`);
	}
	assert.deepEqual(sunDirection(100, 100), sunDirection(30, 40));
	assert.deepEqual(sunDirection(-5, -5), sunDirection(0, 15));
	const [x0, , z0] = sunDirection(0, 20);
	assert.ok(Math.abs(z0) < 1e-12 && x0 < 0, 'azimuth 0 looks straight along +x (no z component)');
	assert.ok(sunDirection(30, 20)[2] < sunDirection(10, 20)[2], 'more azimuth moves the sun towards the back wall (-z)');
	assert.ok(sunDirection(10, 40)[1] > sunDirection(10, 15)[1], 'more elevation = higher sun');
});

test('keyDirection: fixed distance, clamped, front-right by default, azimuth turns it round', () => {
	const dist = Math.hypot(...KEY_POSITION);
	for (const [az, el] of [[0, 25], [90, 85], [-90, 60], [200, 200], [-200, -200]]) {
		const p = keyDirection(az, el);
		assert.ok(Math.abs(Math.hypot(...p) - dist) < 1e-9);
		assert.ok(p[1] > 0);
	}
	assert.deepEqual(keyDirection(500, 500), keyDirection(90, 85));
	assert.ok(keyDirection(30, 50)[0] > keyDirection(-30, 50)[0]);
});

// ---------------------------------------------------------------------------------------------------------------
// scene.json integration: `settings` and `wallColor`
// ---------------------------------------------------------------------------------------------------------------

const sceneWith = (extra: Record<string, unknown>, rooms: Record<string, unknown> = {}) => ({ version: 1, ...extra, rooms });

test('the committed scene.json parses with no warnings, gives the defaults and serializes byte-identical', () => {
	const text = readFileSync(new URL('../src/data/scene.json', import.meta.url), 'utf8');
	const raw = JSON.parse(text);
	const models = JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8')).map((m: { id: string }) => m.id);
	const r = parseScene(raw, { slugs: SLUGS, modelIds: models });
	assert.deepEqual(r.warnings, []);
	if (!('settings' in raw)) assert.deepEqual(r.scene.settings, DEFAULT_SETTINGS, 'no settings key = the defaults');
	assert.equal(serializeScene(r.scene), text, 'serialize(parse(file)) === file');
	for (const slug of SLUGS) if (!raw.rooms[slug]?.wallColor) assert.equal(r.scene.rooms[slug].wallColor, undefined);
});

test('a scene without `settings` (an old file) parses to the defaults with no warning; version stays 1', () => {
	const r = parseScene(sceneWith({}), opts);
	assert.equal(r.ok, true);
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(r.scene.settings, DEFAULT_SETTINGS);
	assert.equal(r.scene.version, 1);
	assert.equal(parseScene(sceneWith({}), {}).scene.settings.floor.tile, 3.2, 'also without slugs');
	assert.deepEqual(emptyScene(SLUGS).settings, DEFAULT_SETTINGS);
	assert.notEqual(emptyScene(SLUGS).settings, DEFAULT_SETTINGS, 'emptyScene gets its own copy');
	assert.notEqual(emptyScene(SLUGS).settings, emptyScene(SLUGS).settings);
});

test('parseScene forwards settings problems as warnings (so Save stays blocked) and still returns usable settings', () => {
	const raw = sceneWith({ settings: { floor: { tile: 999 }, sun: { color: 'blue' }, wall: { bogus: 1 } } });
	const r = parseScene(raw, opts);
	assert.equal(r.ok, true, 'settings trouble does not make the scene unusable');
	assert.equal(r.warnings.length, 2);
	assert.ok(r.warnings.some((w) => w.includes('settings.floor.tile')));
	assert.ok(r.warnings.some((w) => w.includes('settings.sun.color')));
	assert.equal(r.scene.settings.floor.tile, SETTING_RANGES.floor.tile.max);
	assert.equal(r.scene.settings.sun.color, DEFAULT_SETTINGS.sun.color);
	assert.ok(validateScene(raw, opts).length >= 2, 'validateScene is non-empty');
	assert.deepEqual(validateScene(sceneWith({ settings: { floor: { tile: 4 } } }), opts), []);
	// settings garbage on a scene whose rooms are also fine: not fatal, defaults
	assert.deepEqual(parseScene(sceneWith({ settings: 'oops' }), opts).scene.settings, DEFAULT_SETTINGS);
	assert.ok(validateScene(sceneWith({ settings: [] }), opts).length > 0);
});

test('serializeScene: default settings are not written; changed ones are written sparse, between version and rooms', () => {
	const plain = serializeScene(emptyScene(SLUGS));
	assert.deepEqual(Object.keys(JSON.parse(plain)), ['version', 'rooms']);
	const scene = parseScene(sceneWith({ settings: { floor: { tile: 4.5, rotation: 90 }, sun: { color: '#ff8800' } } }), opts).scene;
	const text = serializeScene(scene);
	const json = JSON.parse(text);
	assert.deepEqual(Object.keys(json), ['version', 'settings', 'rooms']);
	assert.deepEqual(json.settings, { floor: { tile: 4.5, rotation: 90 }, sun: { color: '#ff8800' } });
	assert.match(text, /^\{\n {2}"version": 1,\n {2}"settings": \{\n/);
	assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'));
	// stable under reparse
	const again = parseScene(JSON.parse(text), opts);
	assert.deepEqual(again.warnings, []);
	assert.deepEqual(again.scene, scene);
	assert.equal(serializeScene(again.scene), text);
});

test('serializeScene: resetting a value back to its default removes it from the file again', () => {
	const scene = parseScene(sceneWith({ settings: { floor: { tile: 4.5 } } }), opts).scene;
	assert.ok('settings' in JSON.parse(serializeScene(scene)));
	scene.settings.floor.tile = DEFAULT_SETTINGS.floor.tile;
	assert.ok(!('settings' in JSON.parse(serializeScene(scene))));
});

test('serializeScene tolerates a scene object without `settings` (hand-built) and never writes an incomplete key', () => {
	const scene = emptyScene(SLUGS) as unknown as Record<string, unknown>;
	delete scene.settings;
	const json = JSON.parse(serializeScene(scene as never));
	assert.deepEqual(Object.keys(json), ['version', 'rooms']);
});

test('cloneScene deep-copies settings and wallColor', () => {
	const a = parseScene(sceneWith({ settings: { floor: { tile: 4 } } }, { elnur: { objects: [], wallColor: '#112233' } }), opts).scene;
	const b = cloneScene(a);
	assert.deepEqual(b, a);
	b.settings.floor.tile = 9;
	b.rooms.elnur.wallColor = '#ffffff';
	assert.equal(a.settings.floor.tile, 4);
	assert.equal(a.rooms.elnur.wallColor, '#112233');
});

// wallColor

test('wallColor: valid values are kept lower-cased; absent stays absent (key not even present)', () => {
	const r = parseScene(sceneWith({}, { elnur: { objects: [], wallColor: '#AABBCC' }, sabina: { objects: [] }, nadir: { objects: [], wallColor: '#012345' } }), opts);
	assert.deepEqual(r.warnings, []);
	assert.equal(r.scene.rooms.elnur.wallColor, '#aabbcc');
	assert.equal(r.scene.rooms.nadir.wallColor, '#012345');
	assert.equal('wallColor' in r.scene.rooms.sabina, false);
	assert.equal('wallColor' in r.scene.rooms.fazil, false, 'rooms added empty have none either');
	assert.deepEqual(Object.keys(r.scene.rooms.elnur), ['objects', 'wallColor']);
});

test('wallColor: bad values are ignored with a warning naming the room (the room itself is kept)', () => {
	for (const v of ['red', '#abc', '#12345g', '', 5, null, ['#ffffff'], { c: 1 }]) {
		const o = { id: 'bed-1', type: 'bed', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
		const r = parseScene(sceneWith({}, { elnur: { objects: [o], wallColor: v } }), opts);
		assert.equal('wallColor' in r.scene.rooms.elnur, false, JSON.stringify(v));
		assert.equal(r.scene.rooms.elnur.objects.length, 1, 'objects survive a bad wallColor');
		assert.equal(r.warnings.length, 1, JSON.stringify(v));
		assert.ok(r.warnings[0].includes('elnur') && r.warnings[0].includes('wallColor'), r.warnings[0]);
		assert.ok(validateScene(sceneWith({}, { elnur: { objects: [], wallColor: v } }), opts).length > 0);
	}
});

test('wallColor: serialized only when set, after `objects`, and round-trips', () => {
	const scene = emptyScene(SLUGS);
	assert.ok(!serializeScene(scene).includes('wallColor'));
	scene.rooms.sabina.wallColor = '#abcdef';
	scene.rooms.fazil.wallColor = undefined; // explicit undefined is not written
	const text = serializeScene(scene);
	const json = JSON.parse(text);
	assert.deepEqual(Object.keys(json.rooms.sabina), ['objects', 'wallColor']);
	assert.equal(json.rooms.sabina.wallColor, '#abcdef');
	assert.deepEqual(Object.keys(json.rooms.fazil), ['objects']);
	assert.equal((text.match(/wallColor/g) ?? []).length, 1);
	assert.equal(serializeScene(parseScene(json, opts).scene), text);
	// a wallColor without a settings key does not add one
	assert.deepEqual(Object.keys(json), ['version', 'rooms']);
});

// ---------------------------------------------------------------------------------------------------------------
// effectiveColors
// ---------------------------------------------------------------------------------------------------------------

test('effectiveColors: no override returns the family colours themselves (identical object, so output is unchanged)', () => {
	const scene = emptyScene(SLUGS);
	for (const m of family) {
		assert.equal(effectiveColors(m, scene), m.colors, m.slug);
		assert.equal(effectiveColors(m, { rooms: {} }), m.colors, `${m.slug} with no room entry at all`);
	}
});

test('effectiveColors: wallColor overrides BOTH walls, the floor follows as floorOf(override); other rooms unaffected', () => {
	const scene = emptyScene(SLUGS);
	scene.rooms.nadir.wallColor = '#336699';
	const nadir = family.find((m) => m.slug === 'nadir')!;
	const c = effectiveColors(nadir, scene);
	assert.deepEqual(c, { leftWall: '#336699', rightWall: '#336699', floor: floorOf('#336699') });
	assert.deepEqual(Object.keys(c).sort(), ['floor', 'leftWall', 'rightWall'], 'no trim colour sneaks in');
	assert.notEqual(c.floor, nadir.colors.floor);
	assert.match(c.floor, /^#[0-9a-f]{6}$/);
	for (const m of family) if (m.slug !== 'nadir') assert.equal(effectiveColors(m, scene), m.colors, m.slug);
	assert.deepEqual(colorsForWall('#336699'), c);
	assert.equal(nadir.colors.leftWall, '#ecfcca', 'family.ts itself is not mutated');
});

test('effectiveColors: an upper-case or invalid override is handled (lower-cased / ignored), the input scene is not mutated', () => {
	const m = family[0];
	assert.deepEqual(effectiveColors(m, { rooms: { elnur: { objects: [], wallColor: '#ABCDEF' } } }), { leftWall: '#abcdef', rightWall: '#abcdef', floor: floorOf('#abcdef') });
	for (const bad of ['red', '#abc', '', '#GGGGGG']) {
		assert.equal(effectiveColors(m, { rooms: { elnur: { objects: [], wallColor: bad } } }), m.colors, JSON.stringify(bad));
	}
	const scene = { rooms: { elnur: { objects: [], wallColor: '#ABCDEF' } } };
	effectiveColors(m, scene);
	assert.equal(scene.rooms.elnur.wallColor, '#ABCDEF');
});

test('effectiveColors: the override equal to the family wall gives back the family floor literal', () => {
	for (const m of family) {
		const c = effectiveColors(m, { rooms: { [m.slug]: { objects: [], wallColor: m.colors.leftWall } } });
		assert.deepEqual(c, m.colors, m.slug);
	}
});

// ---------------------------------------------------------------------------------------------------------------
// round-2 fixes
// ---------------------------------------------------------------------------------------------------------------

test('floor roughness range is 0..1.3 (three clamps roughness at 1; the default 1.1 is unchanged)', () => {
	assert.deepEqual(SETTING_RANGES.floor.roughness, { min: 0, max: 1.3 });
	assert.equal(DEFAULT_SETTINGS.floor.roughness, 1.1);
	const r = parseSettings({ floor: { roughness: 2 } });
	assert.equal(r.settings.floor.roughness, 1.3);
	assert.equal(r.warnings.length, 1);
	assert.deepEqual(parseSettings({ floor: { roughness: 1.3 } }).warnings, []);
});

test('COLOR_RE is exported once and is the #rrggbb rule used by settings, wallColor and effectiveColors', () => {
	for (const ok of ['#000000', '#ffffff', '#AbCdEf', '#c8e0d0']) assert.ok(COLOR_RE.test(ok), ok);
	for (const bad of ['', '#fff', '#12345', '#1234567', '#ggg000', 'c8e0d0', ' #c8e0d0', '#c8e0d0 ', 'red']) assert.ok(!COLOR_RE.test(bad), JSON.stringify(bad));
	assert.ok(!COLOR_RE.global && !COLOR_RE.sticky, 'no lastIndex state shared between callers');
	// the three consumers agree with it on a sample of strings
	for (const v of ['#c8e0d0', '#C8E0D0', '#c8e0d', 'blue']) {
		const viaScene = 'wallColor' in parseScene({ version: 1, rooms: { elnur: { objects: [], wallColor: v } } }, opts).scene.rooms.elnur;
		const viaEff = effectiveColors(family[0], { rooms: { elnur: { objects: [], wallColor: v } } }) !== family[0].colors;
		const viaSettings = parseSettings({ sun: { color: v } }).warnings.length === 0;
		assert.equal(viaScene, COLOR_RE.test(v), `scene ${v}`);
		assert.equal(viaEff, COLOR_RE.test(v), `effective ${v}`);
		assert.equal(viaSettings, COLOR_RE.test(v), `settings ${v}`);
	}
});

test('angle defaults stay exact through parse and sparse round trip (sliders use step="any" for them)', () => {
	for (const [g, k] of [['sun', 'azimuth'], ['sun', 'elevation'], ['key', 'azimuth'], ['key', 'elevation']] as const) {
		const def = (DEFAULT_SETTINGS as unknown as Flat)[g][k] as number;
		const back = parseSettings({ [g]: { [k]: def } });
		assert.equal((back.settings as unknown as Flat)[g][k], def, `${g}.${k}`);
		assert.deepEqual(back.warnings, []);
	}
});
