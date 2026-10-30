// URLs of the room textures (public/textures, made by scripts/make-textures.sh). room-core.ts loads them and the room
// and admin pages preload them (components/TexturePreload.astro), so the two cannot drift apart. Pure TypeScript, no imports.
export const OAK_DIFFUSE_URL = '/textures/floor/oak-diff.jpg';
export const OAK_ROUGHNESS_URL = '/textures/floor/oak-rough.jpg';
export const STUCCO_DETAIL_URL = '/textures/wall/stucco-detail.jpg';
export const STUCCO_NORMAL_URL = '/textures/wall/stucco-normal.webp';

/**
 * What a page preloads. Touch screens skip the stucco normal map (room-core's `(pointer: coarse)` branch), so its
 * preload carries the matching media query: a preload nothing uses is a console warning.
 */
export const TEXTURE_PRELOADS: readonly { href: string; media?: string }[] = [
	{ href: OAK_DIFFUSE_URL },
	{ href: OAK_ROUGHNESS_URL },
	{ href: STUCCO_DETAIL_URL },
	{ href: STUCCO_NORMAL_URL, media: 'not all and (pointer: coarse)' },
];
