// Unit tests for src/data/family.ts + src/data/room-palette.ts (v2 pastel wall colours, the faintly tinted oak floor, the linear-light multipliers for the textures).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { family } from '../src/data/family.ts';
import {
	OAK_BASE, OAK_LINEAR, FLOOR_TINT, FLOOR_HUE_CAP, WALL_DETAIL_MEAN, WALL_GAIN, WOOD_EDGE,
	hexToRgb, rgbToHex, rgbToHsl, hslToRgb, mixHex, darkenHex, floorOf, floorMultiplier, wallTint,
	srgbToLinear, linearToSrgb, hexToLinear, type Rgb,
} from '../src/data/room-palette.ts';

// room-colors-v2.pdf, in nav order.
const PDF: [string, string][] = [
	['elnur', '#DFF2FE'],
	['sabina', '#EDE9FE'],
	['nadir', '#ECFCCA'],
	['chinara', '#FFE4E6'],
	['alibala', '#FFEDD4'],
	['elkhan', '#FEF9C2'],
	['fazil', '#CBFBF1'],
];
const HEX = /^#[0-9a-f]{6}$/;
const lum = (hex: string) => {
	const [r, g, b] = hexToRgb(hex);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('family: rooms are in PDF order and both walls are the exact v2 PDF hex', () => {
	assert.deepEqual(family.map((m) => m.slug), PDF.map(([s]) => s));
	for (const [i, [slug, hex]] of PDF.entries()) {
		const c = family[i].colors;
		assert.equal(family[i].slug, slug);
		assert.equal(c.leftWall.toLowerCase(), hex.toLowerCase(), `${slug} leftWall`);
		assert.equal(c.rightWall.toLowerCase(), hex.toLowerCase(), `${slug} rightWall`);
	}
});

test('family: all colours are lower-case #rrggbb and the 7 palettes are distinct in every field', () => {
	for (const m of family) {
		for (const [k, v] of Object.entries(m.colors)) assert.match(v, HEX, `${m.slug}.${k}`);
	}
	for (const key of ['leftWall', 'floor'] as const) {
		assert.equal(new Set(family.map((m) => m.colors[key])).size, 7, `${key} values are distinct`);
	}
});

test('family: the floor literals equal what floorOf derives from the wall (the oak with a faint hue cast)', () => {
	for (const m of family) assert.equal(m.colors.floor, floorOf(m.colors.leftWall), `${m.slug} floor`);
	assert.deepEqual(family.map((m) => m.colors.floor), ['#9b7650', '#a37154', '#a07653', '#a37554', '#a37654', '#a27653', '#9d7650']);
});

test('family: no room colour set carries a trim colour any more', () => {
	for (const m of family) assert.deepEqual(Object.keys(m.colors).sort(), ['floor', 'leftWall', 'rightWall'], m.slug);
});

const hueDist = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test('family: the floor is still honey oak (r > g > b, mid tone, warm hue within FLOOR_HUE_CAP of the oak base)', () => {
	const [wh, ws, wl] = rgbToHsl(hexToRgb(OAK_BASE));
	for (const m of family) {
		const [r, g, b] = hexToRgb(m.colors.floor);
		const [h, s, l] = rgbToHsl([r, g, b]);
		assert.ok(r > g && g > b, `${m.slug} floor is brown-ordered (r>g>b): ${m.colors.floor}`);
		assert.ok(lum(m.colors.floor) > 100 && lum(m.colors.floor) < 150, `${m.slug} floor is a mid tone`);
		assert.ok(hueDist(h, wh) <= FLOOR_HUE_CAP, `${m.slug} floor hue ${h} vs oak ${wh}`);
		assert.ok(h > 15 && h < 40, `${m.slug} hue ${h} is warm (no olive/grey cast)`);
		assert.ok(Math.abs(s - ws) < 0.03 && Math.abs(l - wl) < 0.04, `${m.slug} keeps the oak's saturation/lightness (${s}, ${l})`);
	}
});

test('family: the floor carries a faint cast of the room hue (hue moves towards the room, never away)', () => {
	const [wh] = rgbToHsl(hexToRgb(OAK_BASE));
	let moved = 0;
	for (const m of family) {
		const [h] = rgbToHsl(hexToRgb(m.colors.floor));
		const [rh] = rgbToHsl(hexToRgb(m.colors.leftWall));
		const toward = ((rh - wh + 540) % 360) - 180; // signed shortest distance oak -> room
		const shift = ((h - wh + 540) % 360) - 180;
		if (Math.abs(shift) > 0.5) { moved++; assert.ok(Math.sign(shift) === Math.sign(toward), `${m.slug} hue moves towards the room`); }
	}
	assert.ok(moved >= 5, `most rooms shift the oak hue (${moved}/7)`);
});

test('family: the floors are the same oak in every room (each channel within 10 of the oak base) yet 7 distinct literals', () => {
	const base = hexToRgb(OAK_BASE);
	for (const m of family) hexToRgb(m.colors.floor).forEach((v, i) => assert.ok(Math.abs(v - base[i]) <= 10, `${m.slug} channel ${i}`));
	assert.equal(new Set(family.map((m) => m.colors.floor)).size, 7);
});

test('room-palette: OAK_BASE is the measured mean of the shipped diffuse, OAK_LINEAR is it in linear light', () => {
	assert.equal(OAK_BASE, '#a37654');
	assert.deepEqual(OAK_LINEAR, hexToLinear(OAK_BASE));
	// measured from public/textures/floor/oak-diff.jpg: linear mean (0.3644, 0.1810, 0.0888)
	[0.3644, 0.1810, 0.0888].forEach((v, i) => assert.ok(Math.abs(OAK_LINEAR[i] - v) < 0.003, `OAK_LINEAR[${i}] = ${OAK_LINEAR[i]}`));
});

test('room-palette: floorMultiplier is white at OAK_BASE and at anything brighter (clamped to <= 1)', () => {
	assert.deepEqual(floorMultiplier(OAK_BASE), [1, 1, 1]);
	assert.deepEqual(floorMultiplier('#ffffff'), [1, 1, 1]);
	assert.deepEqual(floorMultiplier('#ffffff').map((v) => v <= 1), [true, true, true]);
	assert.deepEqual(floorMultiplier('#000000'), [0, 0, 0]);
	// one channel above the oak is clamped, the others are ratios
	const m = floorMultiplier('#ff3c2a');
	assert.equal(m[0], 1);
	assert.ok(m[1] > 0 && m[1] < 1 && m[2] > 0 && m[2] < 1);
});

test('room-palette: floorMultiplier works in linear light, not on sRGB bytes', () => {
	// half the oak's linear light in every channel is NOT half the bytes
	const half = rgbToHex(OAK_LINEAR.map((v) => linearToSrgb(v / 2)) as unknown as Rgb);
	for (const k of floorMultiplier(half)) assert.ok(Math.abs(k - 0.5) < 0.02, `ratio ${k}`);
	const bytesHalf = rgbToHex(hexToRgb(OAK_BASE).map((v) => v / 2) as unknown as Rgb);
	assert.ok(floorMultiplier(bytesHalf)[0] < 0.25, 'half the bytes is much less than half the light');
});

test('family: every room multiplier is <= 1, within ~10% of white per channel, and multiplier x oak = the literal in linear light', () => {
	for (const m of family) {
		const mult = floorMultiplier(m.colors.floor);
		const lin = hexToLinear(m.colors.floor);
		mult.forEach((k, i) => {
			assert.ok(k <= 1 && k >= 0.89, `${m.slug}[${i}] multiplier ${k}`);
			assert.ok(Math.abs(k * OAK_LINEAR[i] - lin[i]) < 1e-9, `${m.slug}[${i}] exact (never clamped)`);
		});
		// as the 8-bit render: the tinted oak mean stays within 8/255 of the plain oak
		const rendered = mult.map((k, i) => linearToSrgb(k * OAK_LINEAR[i]));
		hexToRgb(OAK_BASE).forEach((v, i) => assert.ok(Math.abs(rendered[i] - v) <= 8, `${m.slug} byte ${i}`));
	}
	assert.deepEqual(floorMultiplier(family.find((m) => m.slug === 'alibala')!.colors.floor), [1, 1, 1], 'alibala sits on the oak hue');
});

test('room-palette: WALL_GAIN undoes the detail map mean; wallTint is the wall in linear light times it', () => {
	assert.equal(WALL_DETAIL_MEAN, 0.95);
	assert.ok(Math.abs(WALL_GAIN - 1 / 0.95) < 1e-12);
	assert.ok(Math.abs(WALL_GAIN * WALL_DETAIL_MEAN - 1) < 1e-12);
	for (const m of family) {
		const lin = hexToLinear(m.colors.leftWall);
		wallTint(m.colors.leftWall).forEach((v, i) => {
			assert.ok(Math.abs(v - lin[i] * WALL_GAIN) < 1e-12, `${m.slug}[${i}]`);
			assert.ok(Math.abs(v * WALL_DETAIL_MEAN - lin[i]) < 1e-12, `${m.slug}[${i}] visible colour is the wall colour`);
		});
	}
	assert.deepEqual(wallTint('#000000'), [0, 0, 0]);
	assert.ok(wallTint('#ffffff')[0] > 1, 'white is boosted above 1 on purpose');
});

test('room-palette: srgbToLinear / linearToSrgb known values and round trip', () => {
	assert.equal(srgbToLinear(0), 0);
	assert.equal(srgbToLinear(255), 1);
	assert.ok(Math.abs(srgbToLinear(128) - 0.2158605) < 1e-6);
	assert.equal(linearToSrgb(0), 0);
	assert.ok(Math.abs(linearToSrgb(1) - 255) < 1e-9);
	assert.equal(linearToSrgb(2), linearToSrgb(1), 'clamped');
	assert.equal(linearToSrgb(-1), 0, 'clamped');
	for (let b = 0; b <= 255; b++) assert.ok(Math.abs(linearToSrgb(srgbToLinear(b)) - b) < 1e-9, `byte ${b}`);
	assert.deepEqual(hexToLinear('#000000'), [0, 0, 0]);
	assert.deepEqual(hexToLinear('#ffffff'), [1, 1, 1]);
});

test('family: walls are pastel (very light) yet each keeps a distinct hue/identity', () => {
	for (const m of family) assert.ok(lum(m.colors.leftWall) > 215, `${m.slug} wall is a light pastel`);
	const hues = family.map((m) => rgbToHsl(hexToRgb(m.colors.leftWall))[0]).sort((a, b) => a - b);
	// Every pair of walls differs clearly in some channel (nearest pair is Chinara/Alibala).
	for (let i = 0; i < family.length; i++)
		for (let j = i + 1; j < family.length; j++) {
			const a = hexToRgb(family[i].colors.leftWall);
			const b = hexToRgb(family[j].colors.leftWall);
			assert.ok(Math.max(...a.map((v, k) => Math.abs(v - b[k]))) >= 6, `${family[i].slug}/${family[j].slug} too close`);
		}
	assert.equal(hues.length, 7);
});

test('room-palette: rgbToHsl/hslToRgb round trip and known values', () => {
	assert.deepEqual(rgbToHsl([255, 0, 0]), [0, 1, 0.5]);
	assert.deepEqual(rgbToHsl([0, 0, 0]), [0, 0, 0]);
	assert.deepEqual(rgbToHsl([255, 255, 255]), [0, 0, 1]);
	const [h, s, l] = rgbToHsl([0, 255, 0]);
	assert.ok(Math.abs(h - 120) < 1e-9 && s === 1 && l === 0.5);
	for (const m of family) for (const hex of [m.colors.leftWall, m.colors.floor, OAK_BASE]) {
		assert.equal(rgbToHex(hslToRgb(rgbToHsl(hexToRgb(hex)))), hex, `round trip ${hex}`);
	}
	assert.equal(rgbToHex(hslToRgb([-120, 1, 0.5])), '#0000ff', 'negative hue wraps');
	assert.equal(rgbToHex(hslToRgb([480, 1, 0.5])), '#00ff00', 'hue above 360 wraps');
});

test('room-palette: floorOf is deterministic, returns #rrggbb, never brighter than the oak, and handles white, black and grey walls', () => {
	for (const w of ['#ffffff', '#000000', '#808080', '#ff0000', '#0000ff', '#dff2fe']) {
		const f = floorOf(w);
		assert.match(f, HEX, `floorOf(${w})`);
		assert.equal(f, floorOf(w));
		hexToLinear(f).forEach((v, i) => assert.ok(v <= OAK_LINEAR[i] + 1e-9, `floorOf(${w}) channel ${i} not above the oak`));
	}
	// A wall of the oak's own hue leaves the oak where it is.
	assert.equal(floorOf(OAK_BASE), OAK_BASE);
	// Even the opposite hue (blue) moves the oak by less than the cap.
	const [wh] = rgbToHsl(hexToRgb(OAK_BASE));
	assert.ok(hueDist(rgbToHsl(hexToRgb(floorOf('#0080ff')))[0], wh) <= FLOOR_HUE_CAP + 0.5);
});

test('room-palette: mixHex endpoints, midpoint and clamping', () => {
	assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
	assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff');
	assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
	assert.equal(mixHex('#102030', '#102030', 0.37), '#102030');
	assert.equal(mixHex('#ff0000', '#00ff00', 2), '#00ff00', 'overshoot is clamped to a byte');
	assert.equal(mixHex('#FF0000', '#0000FF', 0), '#ff0000', 'output is lower-case');
});

test('room-palette: darkenHex scales channels and handles the edges', () => {
	assert.equal(darkenHex('#ffffff', 0), '#ffffff');
	assert.equal(darkenHex('#ffffff', 1), '#000000');
	assert.equal(darkenHex('#80c040', 0.5), '#406020');
});

test('room-palette: hexToRgb/rgbToHex round trip; invalid input throws', () => {
	assert.deepEqual(hexToRgb('#0a1B2c'), [10, 27, 44]);
	assert.equal(rgbToHex([10, 27, 44]), '#0a1b2c');
	assert.equal(rgbToHex([-5, 300, 12.4]), '#00ff0c');
	for (const bad of ['', '#fff', 'red', '#12345g', '123456', '#1234567']) {
		assert.throws(() => hexToRgb(bad), RangeError, bad);
	}
});

test('room-palette: constants are sane (oak base is brown, edge is darker than the base)', () => {
	const [r, g, b] = hexToRgb(OAK_BASE);
	assert.ok(r > g && g > b);
	assert.match(WOOD_EDGE, HEX);
	assert.ok(lum(WOOD_EDGE) < lum(OAK_BASE) / 2, 'dark slab edge');
	assert.ok(FLOOR_TINT > 0 && FLOOR_TINT <= 0.25);
	assert.ok(FLOOR_HUE_CAP > 0 && FLOOR_HUE_CAP <= 15);
});
