// Colour maths for the room palette: the faintly tinted floor oak derived from a room's wall colour, and the linear
// colours the materials multiply with the oak and stucco textures.
// Pure TypeScript with only erasable syntax and no DOM/three/Astro imports, so Node can import it directly
// (`node --test`). family.ts keeps the resulting hex values as literals (it has no value imports); the tests check
// that they still equal what these functions produce.

/** Mean colour of public/textures/floor/oak-diff.jpg (measured from the shipped file, 8-bit sRGB); the base of every room's floor. */
export const OAK_BASE = '#a37654';
/** How far each room's oak hue moves towards the room's hue, as a share of the hue distance. */
export const FLOOR_TINT = 0.03;
/** The hue shift eases off towards this many degrees, so the floor stays honey oak whatever the room colour. */
export const FLOOR_HUE_CAP = 6;
/** Linear-light mean of public/textures/wall/stucco-detail.jpg, which scripts/stucco-detail.py scales to it (0.948 once encoded). */
export const WALL_DETAIL_MEAN = 0.95;
/** Multiplier that makes a wall colour the visible colour again after the detail map has darkened it to its mean. */
export const WALL_GAIN = 1 / WALL_DETAIL_MEAN;
/** Slab edge and underside of the floor: dark wood, the same in every room. */
export const WOOD_EDGE = '#3b2417';

export type Rgb = readonly [number, number, number];

const HEX = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): Rgb {
	if (!HEX.test(hex)) throw new RangeError(`Not a #rrggbb colour: ${hex}`);
	return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function rgbToHex([r, g, b]: Rgb): string {
	const byte = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
	return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** Linear blend in sRGB space: t = 0 gives `a`, t = 1 gives `b`. Returns lower-case #rrggbb. */
export function mixHex(a: string, b: string, t: number): string {
	const [ar, ag, ab] = hexToRgb(a);
	const [br, bg, bb] = hexToRgb(b);
	return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** Darker shade of the same hue: every channel scaled by (1 - amount). */
export function darkenHex(hex: string, amount: number): string {
	const [r, g, b] = hexToRgb(hex);
	const k = 1 - amount;
	return rgbToHex([r * k, g * k, b * k]);
}

/** Hue in degrees [0, 360), saturation and lightness in 0..1. */
export type Hsl = readonly [number, number, number];

export function rgbToHsl([r8, g8, b8]: Rgb): Hsl {
	const r = r8 / 255;
	const g = g8 / 255;
	const b = b8 / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, l];
	const s = d / (1 - Math.abs(2 * l - 1));
	let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	h *= 60;
	return [h < 0 ? h + 360 : h, s, l];
}

export function hslToRgb([h, s, l]: Hsl): Rgb {
	const hue = (((h % 360) + 360) % 360) / 60;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs((hue % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
	return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** sRGB byte (0..255) to linear light (0..1). */
export function srgbToLinear(byte: number): number {
	const c = byte / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear light (0..1) to an sRGB byte, not rounded. */
export function linearToSrgb(linear: number): number {
	const c = Math.min(1, Math.max(0, linear));
	return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
}

/** The linear-light channels of a #rrggbb colour (how three.js stores a Color). */
export function hexToLinear(hex: string): Rgb {
	const [r, g, b] = hexToRgb(hex);
	return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** The oak texture's mean in linear light: the colour a floor multiplier of 1 shows. */
export const OAK_LINEAR: Rgb = hexToLinear(OAK_BASE);

/**
 * The room's floor tint: the oak with its hue nudged towards the room's hue (FLOOR_TINT of the way round, eased so it
 * never passes about FLOOR_HUE_CAP degrees). Saturation and lightness stay the oak's. The result is then dimmed in
 * linear light until no channel is above the oak's (a multiplier cannot brighten), so floorMultiplier() of it is
 * exact up to byte rounding. It is a faint cast, not a colour: `floorMultiplier(floorOf(w))` is within a few percent
 * of white.
 */
export function floorOf(wall: string): string {
	const [wh, ws, wl] = rgbToHsl(hexToRgb(OAK_BASE));
	const [h] = rgbToHsl(hexToRgb(wall));
	const delta = ((((h - wh) % 360) + 540) % 360) - 180; // shortest signed distance, -180..180
	const shift = FLOOR_HUE_CAP * Math.tanh((FLOOR_TINT * delta) / FLOOR_HUE_CAP); // linear for small shifts, then eases off
	const tinted = rgbToHex(hslToRgb([wh + shift, ws, wl]));
	const [r, g, b] = hexToLinear(tinted);
	const dim = Math.min(1, 1 / Math.max(r / OAK_LINEAR[0], g / OAK_LINEAR[1], b / OAK_LINEAR[2]));
	return rgbToHex([linearToSrgb(r * dim), linearToSrgb(g * dim), linearToSrgb(b * dim)]);
}

/**
 * What the floor material's colour must be while the oak texture is on it: the per-channel linear ratio of the room's
 * floor tint to the oak mean, at most 1 (a material colour above 1 would brighten the oak). White for OAK_BASE itself.
 */
export function floorMultiplier(floor: string): Rgb {
	const [r, g, b] = hexToLinear(floor);
	return [Math.min(1, r / OAK_LINEAR[0]), Math.min(1, g / OAK_LINEAR[1]), Math.min(1, b / OAK_LINEAR[2])];
}

/** What a wall material's colour must be while the stucco detail map is on it: the wall's linear colour times WALL_GAIN (may pass 1). */
export function wallTint(wall: string): Rgb {
	const [r, g, b] = hexToLinear(wall);
	return [r * WALL_GAIN, g * WALL_GAIN, b * WALL_GAIN];
}
