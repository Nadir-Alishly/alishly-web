export interface RoomColors {
	leftWall: string;
	rightWall: string;
	floor: string;
	trim: string;
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
		colors: { leftWall: '#b7d4f0', rightWall: '#a3c6ea', floor: '#e7dcc3', trim: '#f6f9fd' },
	},
	{
		slug: 'sabina',
		name: 'Sabina',
		colors: { leftWall: '#f5c8d6', rightWall: '#efb3c7', floor: '#f1dcd0', trim: '#fff7f9' },
	},
	{
		slug: 'nadir',
		name: 'Nadir',
		colors: { leftWall: '#bde6cf', rightWall: '#a9dcc0', floor: '#e4e8cc', trim: '#f6fcf8' },
	},
	{
		slug: 'chinara',
		name: 'Chinara',
		colors: { leftWall: '#d6c9f0', rightWall: '#c6b6ea', floor: '#e9e2ee', trim: '#faf8ff' },
	},
	{
		slug: 'alibala',
		name: 'Alibala',
		colors: { leftWall: '#f8d2b3', rightWall: '#f3bf98', floor: '#e8dccd', trim: '#fffaf4' },
	},
	{
		slug: 'elkhan',
		name: 'Elkhan',
		colors: { leftWall: '#f5e6a6', rightWall: '#eed98e', floor: '#e3dfcd', trim: '#fffdf1' },
	},
	{
		slug: 'fazil',
		name: 'Fazil',
		colors: { leftWall: '#b4e2df', rightWall: '#9fd6d3', floor: '#ecdfd0', trim: '#f5fcfb' },
	},
];
