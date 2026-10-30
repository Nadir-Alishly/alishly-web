// Wall colours are the room colours from room-colors-v2.pdf (both walls). `floor` is the oak floor's faint tint: its hue nudged
// towards the room's, derived by floorOf() in room-palette.ts, which the tests use to check these literals. This file keeps
// no imports so plain Node can load it.
export interface RoomColors {
	leftWall: string;
	rightWall: string;
	/** Faint tint of the oak floor (see floorMultiplier), not a flat floor colour. */
	floor: string;
}

export interface FamilyMember {
	slug: string;
	name: string;
	colors: RoomColors;
}

// Order here is the order of the room switcher and the picker.
export const family: readonly FamilyMember[] = [
	{
		slug: 'elnur',
		name: 'Elnur',
		colors: { leftWall: '#dff2fe', rightWall: '#dff2fe', floor: '#9b7650' },
	},
	{
		slug: 'sabina',
		name: 'Sabina',
		colors: { leftWall: '#ede9fe', rightWall: '#ede9fe', floor: '#a37154' },
	},
	{
		slug: 'nadir',
		name: 'Nadir',
		colors: { leftWall: '#ecfcca', rightWall: '#ecfcca', floor: '#a07653' },
	},
	{
		slug: 'chinara',
		name: 'Chinara',
		colors: { leftWall: '#ffe4e6', rightWall: '#ffe4e6', floor: '#a37554' },
	},
	{
		slug: 'alibala',
		name: 'Alibala',
		colors: { leftWall: '#ffedd4', rightWall: '#ffedd4', floor: '#a37654' },
	},
	{
		slug: 'elkhan',
		name: 'Elkhan',
		colors: { leftWall: '#fef9c2', rightWall: '#fef9c2', floor: '#a27653' },
	},
	{
		slug: 'fazil',
		name: 'Fazil',
		colors: { leftWall: '#cbfbf1', rightWall: '#cbfbf1', floor: '#9d7650' },
	},
];
