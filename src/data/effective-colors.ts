// The colours a room is actually drawn with: family.ts, unless scene.json overrides the wall colour for that room.
// One helper for the room page, the picker swatches and the admin, so they cannot disagree.
// Pure TypeScript, erasable syntax, no DOM/three/Astro imports (type-only imports below), so Node can import it.
import type { FamilyMember, RoomColors } from './family';
import { floorOf } from './room-palette.ts';
import { COLOR_RE } from './scene-settings.ts';
import type { SceneData } from './scene';

/** Both walls take `wallColor`; the floor is its faint oak tint, floorOf(wallColor). */
export function colorsForWall(wallColor: string): RoomColors {
	const wall = wallColor.toLowerCase();
	return { leftWall: wall, rightWall: wall, floor: floorOf(wall) };
}

/** `member.colors` itself (same object) when the room has no wall colour override. */
export function effectiveColors(
	member: Pick<FamilyMember, 'slug' | 'colors'>,
	scene: Pick<SceneData, 'rooms'>,
): RoomColors {
	const wallColor = scene.rooms[member.slug]?.wallColor;
	return wallColor && COLOR_RE.test(wallColor) ? colorsForWall(wallColor) : member.colors;
}
