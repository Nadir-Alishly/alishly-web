import {
	AdditiveBlending,
	Box3,
	BoxGeometry,
	CanvasTexture,
	Color,
	DirectionalLight,
	Float32BufferAttribute,
	HemisphereLight,
	MathUtils,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	MeshLambertMaterial,
	MeshStandardMaterial,
	NeutralToneMapping,
	OrthographicCamera,
	PCFShadowMap,
	PlaneGeometry,
	PMREMGenerator,
	RepeatWrapping,
	Scene,
	Spherical,
	SRGBColorSpace,
	Texture,
	TextureLoader,
	Vector3,
	WebGLRenderer,
} from 'three';
import type { BufferGeometry, Material, Object3D, WebGLRenderTarget } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { RoomColors } from '../data/family';
import { ROOM_DIMS } from '../data/scene';
import { FLOOR_PLANKS, mulberry32, plankLayout } from '../data/room-floor';
import { haloRect, HALO_SPREAD, polygonBounds, POOL_SPREAD, sunPatch } from '../data/room-glow';
import type { Rect } from '../data/room-glow';
import { floorMultiplier, OAK_LINEAR, WOOD_EDGE, wallTint } from '../data/room-palette';
import { OAK_DIFFUSE_URL, OAK_ROUGHNESS_URL, STUCCO_DETAIL_URL, STUCCO_NORMAL_URL } from '../data/room-textures';
import { boxUvs } from '../data/room-uv';
import { leftWallPieces, WINDOW_OPENING, windowFrame } from '../data/room-window';
import { SUN_POSITION as SUN_XYZ, sunBlockerBox, wallCaps } from '../data/room-sun';
import type { SceneObject } from '../data/scene';
import { createObjectManager } from './room-objects';
import type { ObjectManager } from './room-objects';

export interface RoomConfig {
	name: string;
	colors: RoomColors;
	/** Furniture of the room. Applied by createRoomScene(); the core itself only draws the room shell. */
	objects?: readonly SceneObject[];
}

/**
 * The room shell (floor, walls with a window, lights, soft shadows, drop shadow), camera, orbit controls,
 * on-demand render loop and the object manager, shared by the public viewer (room-scene.ts) and the admin editor.
 */
export interface RoomCore {
	readonly scene: Scene;
	readonly camera: OrthographicCamera;
	readonly renderer: WebGLRenderer;
	readonly controls: OrbitControls;
	readonly canvas: HTMLCanvasElement;
	/** Furniture lives here; it is part of `scene` and disposed with it. */
	readonly objects: ObjectManager;
	/** Request a repaint. Call after ANY change to the scene: rendering is on demand. */
	invalidate(): void;
	/** Swap to another room's shell in place: tweens colours, eases the camera home. Does not touch objects. */
	setRoom(config: RoomConfig): void;
	/** Release every GPU/DOM resource. Safe to call more than once. */
	dispose(): void;
}

// Room dimensions in world units. The floor top is y = 0.
const { half: HALF, inner: INNER, wallHeight: WALL_HEIGHT, slab: SLAB } = ROOM_DIMS;

// Camera orbits this point; it is the centre of the room's bounding box.
const TARGET = new Vector3(0, (WALL_HEIGHT - SLAB) / 2, 0);
const CAMERA_DISTANCE = 40; // arbitrary for an orthographic camera, just inside near/far
const DEFAULT_OFFSET = new Vector3(1, 1, 1).setLength(CAMERA_DISTANCE); // true isometric
const FRAME_MARGIN = 1.12;
const MAX_PIXEL_RATIO = 2;

const AZIMUTH_RANGE = MathUtils.degToRad(30);
const POLAR_MIN = MathUtils.degToRad(32); // never straight down
const POLAR_MAX = MathUtils.degToRad(75); // never below the floor plane
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.2;

const TWEEN_MS = 400;

// Lighting (bright, soft daylight). Colours are sRGB hex; intensities are for physical lights under Neutral tone mapping.
const KEY_COLOR = 0xfff0d9; // warm key from the open front, soft contact shadows
const KEY_INTENSITY = 1.8;
const KEY_POSITION = new Vector3(4.5, 9, 8); // leans to +z: the right wall catches more of it than the window wall
const KEY_MAP_SIZE = 1024;
const KEY_SHADOW_RADIUS = 4; // 5 PCF taps: a larger radius turns into grain
const FILL_SKY = 0xe6efff; // cool fill from above, warm bounce from below
const FILL_GROUND = 0xd9cbb8;
const FILL_INTENSITY = 0.6;
const ENV_INTENSITY = 0.2; // RoomEnvironment image-based light: soft ambient bounce
const SUN_COLOR = 0xffe2b8; // outside the left wall, shines through the window
const SUN_INTENSITY = 5.2; // the floor patch is the room's bright spot; kept low enough not to clip pale furniture in it
const SUN_POSITION = new Vector3(...SUN_XYZ);
const SUN_MAP_SIZE = 2048; // 1024 on touch devices
const SUN_SHADOW_RADIUS = 4;
const SHADOW_MARGIN = 0.3;
const SHADOW_BIAS = -0.0004;
const SHADOW_NORMAL_BIAS = 0.03;
// Textures (public/textures, made by scripts/make-textures.sh). Until they are in, the first render is held for at most
// TEXTURE_WAIT_MS; after that the procedural floor and flat walls are drawn and the textures are swapped in when they arrive.
const TEXTURE_WAIT_MS = 1500;
// Oak floor. The material colour is a faint per-room multiplier (floorMultiplier); the oak texture is the colour.
const FLOOR_TILE = 3.2; // world units per texture repeat: 2 x 2 repeats on the 6.4 floor, boards about 0.23 wide
const OAK_ROUGHNESS = 1.1; // multiplies the roughness map (mean 0.44): satin, a broad sheen from the key light and the sun
// Stucco walls (Lambert, so the lighting stays as calibrated). The detail map's mean is WALL_DETAIL_MEAN, undone by WALL_GAIN.
// The grain is far finer than a screen pixel at the default view, so a big tile (the 1024 px map spans 8 units: texels
// about a pixel) and a normal scale above 1 are what make it just noticeable there; the detail map's contrast is set in
// scripts/stucco-detail.py. The normal map is skipped on touch screens.
const WALL_TILE = 8; // world units per texture repeat
const WALL_NORMAL_SCALE = 2; // above 1 on purpose: the grain is sub-pixel at the default view
// Procedural plank floor, the fallback while the oak is not there. Painted around a light neutral so that `colour x map`
// reads as the room's wood.
const FLOOR_TEXTURE_SIZE = 1024; // px; one tile covers the whole 6.4 x 6.4 floor top (160 px per world unit)
const FLOOR_ROUGHNESS = 0.5; // satin: a broad sheen from the key light and the sun, no mirror image
const FLOOR_ENV_INTENSITY = 0.35; // image-based light on the floor only (scene.environmentIntensity is 0.2)
const PLANK_LIGHTNESS = 0.9; // average map value (0..1)
const PLANK_VARIATION = 0.055; // +- tone shift between planks
const SEAM_ROW_PX = 3; // seam along the planks
const SEAM_JOINT_PX = 2.5; // seam at plank ends
// Window glow: warm-white unlit panes, a halo on the wall around them and a light pool on the floor.
const PANE_TOP = '#ffffff';
const PANE_BOTTOM = '#fffdf8'; // near-pure white: the reference's panes are blown out, not cream
const GLOW_COLOR = 0xffd9a6; // warm tint of the additive halo and pool: reads as sunlight on pale walls too
const HALO_OPACITY = 0.75;
const HALO_OFFSET = 0.012; // in front of the wall face, so the two never fight
const POOL_OPACITY = 0.14; // additive on top of the sun patch: any more clips the oak's red there
const POOL_Y = 0.004; // above the floor top, with polygonOffset on top
const DROP_SHADOW_SIZE = 11; // world units; the blob is a blurred square a little smaller than the slab
const DROP_SHADOW_GAP = 0.35; // below the slab

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const ariaLabel = (config: RoomConfig) =>
	`Isometric 3D view of ${config.name}'s room. Drag to rotate, scroll or pinch to zoom.`;

function disposeObject(root: Object3D) {
	root.traverse((object) => {
		const { geometry, material } = object as Partial<Mesh>;
		geometry?.dispose();
		const materials: Material[] = Array.isArray(material) ? material : material ? [material] : [];
		for (const m of materials) {
			for (const value of Object.values(m)) {
				if (value instanceof Texture) value.dispose();
			}
			m.dispose();
		}
	});
}

/** Faint vertical gradient for the window panes: pure white at the top, a little cream at the bottom. */
function paneTexture() {
	const canvas = document.createElement('canvas');
	canvas.width = 4;
	canvas.height = 128;
	const ctx = canvas.getContext('2d');
	if (ctx) {
		const gradient = ctx.createLinearGradient(0, 0, 0, 128);
		gradient.addColorStop(0, PANE_TOP);
		gradient.addColorStop(1, PANE_BOTTOM);
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, 4, 128);
	}
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	return texture;
}

/**
 * Wooden planks, painted around a light neutral so the material colour (the room's wood tint) sets the real colour.
 * Planks run along u (world x on the floor top): a faint grain and tone per plank, dark seams between planks and rows.
 * Layout and PRNG are seeded, so the floor looks the same on every load.
 */
function floorTexture(maxAnisotropy: number) {
	const size = FLOOR_TEXTURE_SIZE;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (ctx) {
		const { rows, planks } = plankLayout();
		const rand = mulberry32(FLOOR_PLANKS.seed ^ 0x9e3779b9);
		const rowH = size / rows;
		const base = PLANK_LIGHTNESS * 255;
		ctx.fillStyle = `rgb(${base},${base},${base})`;
		ctx.fillRect(0, 0, size, size);
		for (const plank of planks) {
			const x0 = plank.u0 * size;
			const x1 = plank.u1 * size;
			const y0 = plank.row * rowH;
			const light = base * (1 + plank.tone * PLANK_VARIATION);
			ctx.save();
			ctx.beginPath();
			ctx.rect(x0, y0, x1 - x0, rowH);
			ctx.clip();
			ctx.fillStyle = `rgb(${light * (1 + plank.tone * 0.015)},${light},${light * (1 - plank.tone * 0.025)})`;
			ctx.fillRect(x0, y0, x1 - x0, rowH);
			// A little brighter along one edge of each plank.
			const edge = ctx.createLinearGradient(0, y0, 0, y0 + rowH);
			edge.addColorStop(0, 'rgba(255,255,255,0.05)');
			edge.addColorStop(1, 'rgba(0,0,0,0.05)');
			ctx.fillStyle = edge;
			ctx.fillRect(x0, y0, x1 - x0, rowH);
			// Grain: thin wobbling strokes along the plank.
			const strokes = 6 + Math.floor(rand() * 6);
			for (let i = 0; i < strokes; i++) {
				const y = y0 + rand() * rowH;
				const amp = 0.6 + rand() * 1.6;
				const wave = 50 + rand() * 150;
				const phase = rand() * Math.PI * 2;
				ctx.strokeStyle = `rgba(70,40,20,${0.05 + rand() * 0.09})`;
				ctx.lineWidth = 0.6 + rand() * 1.4;
				ctx.beginPath();
				for (let x = x0; x <= x1 + 8; x += 8) {
					const yy = y + Math.sin(x / wave + phase) * amp;
					if (x === x0) ctx.moveTo(x, yy);
					else ctx.lineTo(x, yy);
				}
				ctx.stroke();
			}
			ctx.restore();
		}
		// Seams on top: a dark line, with a thin light edge after it (a hint of bevel).
		for (let r = 1; r < rows; r++) {
			const y = r * rowH;
			ctx.fillStyle = 'rgba(28,16,8,0.8)';
			ctx.fillRect(0, y - SEAM_ROW_PX / 2, size, SEAM_ROW_PX);
			ctx.fillStyle = 'rgba(255,255,255,0.22)';
			ctx.fillRect(0, y + SEAM_ROW_PX / 2, size, 1);
		}
		for (const plank of planks) {
			if (plank.u0 <= 0) continue;
			const x = plank.u0 * size;
			const y = plank.row * rowH;
			ctx.fillStyle = 'rgba(28,16,8,0.8)';
			ctx.fillRect(x - SEAM_JOINT_PX / 2, y, SEAM_JOINT_PX, rowH);
			ctx.fillStyle = 'rgba(255,255,255,0.22)';
			ctx.fillRect(x + SEAM_JOINT_PX / 2, y, 1, rowH);
		}
	}
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	texture.wrapS = texture.wrapT = RepeatWrapping;
	texture.repeat.setScalar((2 * HALF) / FLOOR_PLANKS.size); // 1: one tile covers the floor top
	texture.anisotropy = maxAnisotropy; // the seams are seen at a shallow angle and blur without it
	return texture;
}

/** Blurred shape (drawn with shadowBlur, no ctx.filter: Safari) as white with soft alpha; `draw` fills it in canvas px. */
function glowCanvas(width: number, height: number, blur: number, draw: (ctx: CanvasRenderingContext2D) => void) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (ctx) {
		const far = Math.max(width, height) * 4; // the shape is drawn off-canvas; only its blurred shadow lands inside
		ctx.shadowColor = '#fff';
		ctx.shadowBlur = blur;
		ctx.shadowOffsetX = far;
		ctx.translate(-far, 0);
		ctx.fillStyle = '#000';
		draw(ctx);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.shadowColor = 'transparent';
	}
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	return { canvas, ctx, texture };
}

/** Halo on the wall: bright just outside the opening, fading out over `spread`. The opening itself is left clear. */
function haloTexture(rect: Rect, hole: Rect, spreadPx: number) {
	const width = 256;
	const height = Math.round((width * (rect.y1 - rect.y0)) / (rect.z1 - rect.z0));
	// Canvas y runs down, the rect's y runs up. The plane is turned to face +x, so its u runs towards -z: mirror z.
	const px = {
		x0: (1 - hole.z1) * width,
		x1: (1 - hole.z0) * width,
		y0: (1 - hole.y1) * height,
		y1: (1 - hole.y0) * height,
	};
	const grow = spreadPx * 0.25; // moves the 50% point out from the edge, so the edge itself is near full strength
	const { ctx, texture } = glowCanvas(width, height, spreadPx * 0.8, (c) =>
		c.fillRect(px.x0 - grow, px.y0 - grow, px.x1 - px.x0 + grow * 2, px.y1 - px.y0 + grow * 2),
	);
	if (ctx) {
		ctx.globalCompositeOperation = 'destination-out';
		ctx.fillRect(px.x0, px.y0, px.x1 - px.x0, px.y1 - px.y0);
	}
	return texture;
}

/** Soft light pool on the floor: the sun's patch (a polygon of [x, z] points) with a blurred rim. */
function poolTexture(points: readonly (readonly [number, number])[], bounds: { x0: number; z0: number; x1: number; z1: number }) {
	const scale = 64; // px per world unit
	const width = Math.ceil((bounds.x1 - bounds.x0) * scale);
	const height = Math.ceil((bounds.z1 - bounds.z0) * scale);
	const { texture } = glowCanvas(width, height, POOL_SPREAD * scale * 0.8, (c) => {
		c.beginPath();
		points.forEach(([x, z], i) => {
			const px = (x - bounds.x0) * scale;
			const py = (z - bounds.z0) * scale; // canvas y runs down = +z
			if (i === 0) c.moveTo(px, py);
			else c.lineTo(px, py);
		});
		c.closePath();
		c.fill();
	});
	return texture;
}

/** Soft blurred square, fading to nothing well inside the texture. Drawn with shadowBlur (no ctx.filter: Safari). */
function dropShadowTexture() {
	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (ctx) {
		const half = (3.1 / DROP_SHADOW_SIZE) * size; // half the blurred square, in px
		const far = size * 4; // the shape is drawn off-canvas; only its blurred shadow lands inside
		ctx.shadowColor = 'rgba(70, 52, 38, 0.42)';
		ctx.shadowBlur = 40;
		ctx.shadowOffsetX = far;
		ctx.fillStyle = '#000';
		ctx.fillRect(size / 2 - half - far, size / 2 - half, half * 2, half * 2);
	}
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace; // the colour is meant as sRGB; without this it is read as linear and washes out
	return texture;
}

/** Fits an orthographic shadow camera tightly around `bounds` as seen from the light, aimed at the origin. */
function fitShadowCamera(light: DirectionalLight, bounds: Box3) {
	// The target is never added to the scene, so its position is also its world position (the origin).
	light.updateMatrixWorld();
	const view = new Matrix4()
		.lookAt(light.position, light.target.position, new Vector3(0, 1, 0))
		.setPosition(light.position)
		.invert();
	const lo = new Vector3(Infinity, Infinity, Infinity);
	const hi = new Vector3(-Infinity, -Infinity, -Infinity);
	const p = new Vector3();
	for (const x of [bounds.min.x, bounds.max.x]) {
		for (const y of [bounds.min.y, bounds.max.y]) {
			for (const z of [bounds.min.z, bounds.max.z]) {
				p.set(x, y, z).applyMatrix4(view);
				lo.min(p);
				hi.max(p);
			}
		}
	}
	const camera = light.shadow.camera;
	camera.left = lo.x;
	camera.right = hi.x;
	camera.bottom = lo.y;
	camera.top = hi.y;
	camera.near = Math.max(0.1, -hi.z); // the view looks down -z
	camera.far = -lo.z;
	camera.updateProjectionMatrix();
}

/** Returns null (after a console warning) when WebGL cannot start; the caller shows its own fallback. */
export function createRoomCore(canvas: HTMLCanvasElement, initial: RoomConfig): RoomCore | null {
	let renderer: WebGLRenderer;
	try {
		renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
	} catch (error) {
		console.warn('Could not create a WebGL renderer.', error);
		return null;
	}
	renderer.setClearColor(0x000000, 0);
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = NeutralToneMapping; // keeps the pastel palette true
	renderer.toneMappingExposure = 1;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = PCFShadowMap; // soft through light.shadow.radius
	// Shadows are static between edits, so they are only re-rendered after invalidate() (see `shadowDirty`),
	// not on every orbit frame.
	renderer.shadowMap.autoUpdate = false;

	canvas.setAttribute('role', 'img');
	canvas.setAttribute('aria-label', ariaLabel(initial));

	// --- Room ---------------------------------------------------------------
	const scene = new Scene();
	const box = new BoxGeometry(1, 1, 1); // shared by the floor and the shadow blocker, which are scaled/moved copies
	const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
	const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
	// The floor top is a satin MeshStandardMaterial. It starts with the procedural plank texture (the fallback) and gets
	// the oak maps when they are loaded; its colour is the room's wood tint, or its multiplier of the oak.
	const fallbackFloorMap = floorTexture(maxAnisotropy);
	const floorTop = new MeshStandardMaterial({ map: fallbackFloorMap, roughness: FLOOR_ROUGHNESS, metalness: 0 });
	// The walls are flat until the stucco maps are loaded.
	const mats = {
		leftWall: new MeshLambertMaterial(),
		rightWall: new MeshLambertMaterial(),
		floor: floorTop,
	};
	const colorKeys = Object.keys(mats) as (keyof RoomColors)[];
	// Not in `mats` (the colour tween walks every key there): the slab edge is the same dark wood in every room, and
	// the window wood follows the floor's tint whenever it changes.
	const floorEdge = new MeshLambertMaterial({ color: WOOD_EDGE });
	const windowWood = new MeshLambertMaterial();

	// A `geometry` is already placed in world space (see wallBox); without one the part is a scaled/moved copy of `box`.
	const part = (material: Material | Material[], min: Vector3, max: Vector3, geometry?: BufferGeometry) => {
		const mesh = new Mesh(geometry ?? box, material);
		if (!geometry) {
			mesh.scale.subVectors(max, min);
			mesh.position.addVectors(min, max).multiplyScalar(0.5);
		}
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		scene.add(mesh);
		return mesh;
	};
	const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
	const partOf = (material: Material | Material[], b: { min: readonly number[]; max: readonly number[] }) =>
		part(material, v(b.min[0], b.min[1], b.min[2]), v(b.max[0], b.max[1], b.max[2]));
	// A wall piece has its own box with UVs from its world position, so the stucco runs unbroken over all the pieces
	// (a shared unit box would stretch the texture differently on every piece and face).
	const wallBox = (min: Vector3, max: Vector3) => {
		const size = new Vector3().subVectors(max, min);
		const centre = new Vector3().addVectors(min, max).multiplyScalar(0.5);
		const geometry = new BoxGeometry(size.x, size.y, size.z).translate(centre.x, centre.y, centre.z);
		const { position, normal } = geometry.attributes;
		geometry.setAttribute('uv', new Float32BufferAttribute(boxUvs(position.array, normal.array, WALL_TILE), 2));
		return geometry;
	};
	const wall = (material: Material, min: Vector3, max: Vector3) => part(material, min, max, wallBox(min, max));
	const wallOf = (material: Material, b: { min: readonly number[]; max: readonly number[] }) =>
		wall(material, v(b.min[0], b.min[1], b.min[2]), v(b.max[0], b.max[1], b.max[2]));

	// Floor slab, then the two back walls (-x on the left of the view, -z on the right).
	// The front sides are left out on purpose: that is the cut-away.
	// Box faces are +x, -x, +y, -y, +z, -z: planks on top, dark wood on the edge and underside.
	part([floorEdge, floorEdge, mats.floor, floorEdge, floorEdge, floorEdge], v(-HALF, -SLAB, -HALF), v(HALF, 0, HALF));
	// The left wall has a window: four boxes around the opening, all in the wall colour.
	for (const piece of leftWallPieces(ROOM_DIMS)) wallOf(mats.leftWall, piece);
	wall(mats.rightWall, v(-INNER, 0, -HALF), v(HALF, WALL_HEIGHT, -INNER));
	// Thin caps on the wall tops in the wall colour. They neither cast nor receive shadows, so both tops read as the
	// same light band whatever the sun's shadow map does (see wallCaps). Looks only: the sun blocker below is still
	// needed. Not pickable: only `objects.root` is ray-tested.
	const caps = wallCaps(ROOM_DIMS);
	for (const [material, cap] of [[mats.leftWall, caps.left], [mats.rightWall, caps.right]] as const) {
		const mesh = wallOf(material, cap);
		mesh.castShadow = false;
		mesh.receiveShadow = false;
	}

	// Window frame, muntins and sill are oak in the floor's tint (windowWood, kept in step with mats.floor). The panes,
	// halo, light pool and drop shadow have their own materials too. None of them is in `mats`.
	const win = windowFrame(ROOM_DIMS);
	for (const b of [win.sill, ...win.frame, ...win.muntins]) partOf(windowWood, b);
	const { glazing } = win;
	// Unlit warm-white pane in the opening: a light source, not a view of the sky, and opaque so the page never shows
	// through. It is slightly larger than the opening and its edges hide inside the wall pieces. It does not cast
	// shadows: the sun passes it.
	const pane = new Mesh(
		new PlaneGeometry(glazing.z1 - glazing.z0 + 0.5, glazing.y1 - glazing.y0 + 0.5),
		new MeshBasicMaterial({ map: paneTexture(), toneMapped: false }),
	);
	pane.rotation.y = Math.PI / 2; // normal +x, towards the room
	pane.position.set(glazing.paneX, (glazing.y0 + glazing.y1) / 2, (glazing.z0 + glazing.z1) / 2);
	scene.add(pane);
	// Glow on the wall around the opening. Additive and depth-tested, so furniture in front of the wall hides it.
	const { rect: haloArea, hole } = haloRect(ROOM_DIMS, WINDOW_OPENING);
	const halo = new Mesh(
		new PlaneGeometry(haloArea.z1 - haloArea.z0, haloArea.y1 - haloArea.y0),
		new MeshBasicMaterial({
			map: haloTexture(haloArea, hole, (256 * HALO_SPREAD) / (haloArea.z1 - haloArea.z0)),
			color: GLOW_COLOR,
			opacity: HALO_OPACITY,
			transparent: true,
			blending: AdditiveBlending,
			depthWrite: false,
			toneMapped: false,
		}),
	);
	halo.rotation.y = Math.PI / 2;
	halo.position.set(-INNER + HALO_OFFSET, (haloArea.y0 + haloArea.y1) / 2, (haloArea.z0 + haloArea.z1) / 2);
	halo.renderOrder = 1;
	scene.add(halo);
	// Soft pool of light on the floor, around the sun's patch. The patch itself is real sunlight with muntin shadows.
	const patch = sunPatch(ROOM_DIMS, WINDOW_OPENING, SUN_XYZ);
	const poolArea = polygonBounds(patch, POOL_SPREAD);
	const pool = new Mesh(
		new PlaneGeometry(poolArea.x1 - poolArea.x0, poolArea.z1 - poolArea.z0),
		new MeshBasicMaterial({
			map: poolTexture(patch, poolArea),
			color: GLOW_COLOR,
			opacity: POOL_OPACITY,
			transparent: true,
			blending: AdditiveBlending,
			depthWrite: false,
			toneMapped: false,
			polygonOffset: true,
			polygonOffsetFactor: -2,
			polygonOffsetUnits: -2,
		}),
	);
	pool.rotation.x = -Math.PI / 2;
	pool.position.set((poolArea.x0 + poolArea.x1) / 2, POOL_Y, (poolArea.z0 + poolArea.z1) / 2);
	pool.renderOrder = 1;
	scene.add(pool);

	// Soft shadow on the page background under the floating room.
	const dropShadow = new Mesh(
		new PlaneGeometry(DROP_SHADOW_SIZE, DROP_SHADOW_SIZE),
		new MeshBasicMaterial({ map: dropShadowTexture(), transparent: true, depthWrite: false, toneMapped: false }),
	);
	dropShadow.rotation.x = -Math.PI / 2;
	dropShadow.position.y = -SLAB - DROP_SHADOW_GAP;
	scene.add(dropShadow);

	const objects = createObjectManager(() => invalidate());
	scene.add(objects.root);

	// --- Light ----------------------------------------------------------------
	const fill = new HemisphereLight(FILL_SKY, FILL_GROUND, FILL_INTENSITY);
	scene.add(fill);

	const roomBounds = new Box3(
		v(-HALF - SHADOW_MARGIN, -SLAB - SHADOW_MARGIN, -HALF - SHADOW_MARGIN),
		v(HALF + SHADOW_MARGIN, WALL_HEIGHT + SHADOW_MARGIN, HALF + SHADOW_MARGIN),
	);
	// Shadow-only extension of the left wall (see sunBlockerBox): draws nothing, only casts into the sun's shadow map.
	// It keeps the sun off furniture and the rest of the room, including against the back wall, whatever the caps show.
	const sunBlocker = sunBlockerBox(ROOM_DIMS);
	const blocker = partOf(new MeshBasicMaterial({ colorWrite: false, depthWrite: false }), sunBlocker);
	blocker.receiveShadow = false;
	// The sun's shadow camera must contain the whole blocker, or its back end is clipped and the sun leaks past it over the right wall.
	const sunBounds = roomBounds
		.clone()
		.expandByPoint(v(...sunBlocker.min))
		.expandByPoint(v(...sunBlocker.max));

	const shadowLight = (
		color: number,
		intensity: number,
		position: Vector3,
		mapSize: number,
		radius: number,
		bounds: Box3,
	) => {
		const light = new DirectionalLight(color, intensity);
		light.position.copy(position); // aims at the origin (the default target)
		light.castShadow = true;
		light.shadow.mapSize.setScalar(Math.min(mapSize, renderer.capabilities.maxTextureSize));
		light.shadow.radius = radius;
		light.shadow.bias = SHADOW_BIAS;
		light.shadow.normalBias = SHADOW_NORMAL_BIAS;
		fitShadowCamera(light, bounds);
		scene.add(light);
		return light;
	};
	const keyLight = shadowLight(KEY_COLOR, KEY_INTENSITY, KEY_POSITION, KEY_MAP_SIZE, KEY_SHADOW_RADIUS, roomBounds);
	// The sun stands outside the left wall: only the window opening lets its light (and the muntins' shadows) in.
	const sunMapSize = coarsePointer ? 1024 : SUN_MAP_SIZE;
	const sunLight = shadowLight(SUN_COLOR, SUN_INTENSITY, SUN_POSITION, sunMapSize, SUN_SHADOW_RADIUS, sunBounds);
	const lights = [keyLight, sunLight];

	// Soft image-based ambient light. Optional: without it (no PMREM support) the scene just looks flatter.
	let environment: WebGLRenderTarget | null = null;
	const buildEnvironment = () => {
		environment?.dispose();
		environment = null;
		scene.environment = null;
		floorTop.envMap = null;
		let generator: PMREMGenerator | null = null;
		let room: RoomEnvironment | null = null;
		let target: WebGLRenderTarget | null = null;
		try {
			generator = new PMREMGenerator(renderer);
			room = new RoomEnvironment();
			target = generator.fromScene(room, 0.04);
			scene.environment = target.texture;
			scene.environmentIntensity = ENV_INTENSITY;
			// A material's own envMap is what lets it use its own intensity (the scene's applies otherwise).
			floorTop.envMap = target.texture;
			floorTop.envMapIntensity = FLOOR_ENV_INTENSITY;
			floorTop.needsUpdate = true;
			environment = target;
		} catch (error) {
			console.warn('Could not create the room environment light.', error);
			target?.dispose();
			scene.environment = null;
			floorTop.envMap = null;
		} finally {
			room?.dispose();
			generator?.dispose();
		}
	};
	buildEnvironment();

	// What a material colour means depends on the maps on it: with the oak the floor colour is a multiplier of it, with the
	// stucco the wall colours carry WALL_GAIN so they stay the visible colour. The fallbacks (procedural floor, flat walls)
	// use the hex as it is. Everything that sets or tweens a colour goes through colorOf().
	let oakFloor = false;
	let stuccoWalls = false;
	const oakLinear = new Color().setRGB(...OAK_LINEAR);
	const colorOf = (key: keyof RoomColors, hex: string) => {
		if (key === 'floor') return oakFloor ? new Color().setRGB(...floorMultiplier(hex)) : new Color(hex);
		return stuccoWalls ? new Color().setRGB(...wallTint(hex)) : new Color(hex);
	};
	// Oak: the tint times the oak's mean, so the frame is the floor's wood, not white. Fallback: the floor colour itself.
	const syncWindowWood = () => {
		windowWood.color.copy(mats.floor.color);
		if (oakFloor) windowWood.color.multiply(oakLinear);
	};
	const applyColors = (colors: RoomColors) => {
		for (const key of colorKeys) mats[key].color.copy(colorOf(key, colors[key]));
		syncWindowWood();
	};
	applyColors(initial.colors);
	let current = initial;

	// --- Camera and controls ------------------------------------------------
	const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, CAMERA_DISTANCE * 2.5);
	camera.position.copy(TARGET).add(DEFAULT_OFFSET);
	camera.lookAt(TARGET);

	const home = new Spherical().setFromVector3(DEFAULT_OFFSET);

	// Half-extents of the room's bounding box as seen from the default view. The box
	// is centred on TARGET, so its projection is symmetric and these two numbers fit it.
	let fitHalfW = 0;
	let fitHalfH = 0;
	camera.updateMatrixWorld();
	for (const sx of [-1, 1]) {
		for (const sy of [-1, 1]) {
			for (const sz of [-1, 1]) {
				const p = v(sx * HALF, (sy * (WALL_HEIGHT + SLAB)) / 2, sz * HALF)
					.add(TARGET)
					.applyMatrix4(camera.matrixWorldInverse);
				fitHalfW = Math.max(fitHalfW, Math.abs(p.x));
				fitHalfH = Math.max(fitHalfH, Math.abs(p.y));
			}
		}
	}
	fitHalfW *= FRAME_MARGIN;
	fitHalfH *= FRAME_MARGIN;

	const controls = new OrbitControls(camera, canvas);
	controls.target.copy(TARGET);
	controls.enablePan = false;
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.rotateSpeed = 0.7;
	controls.minAzimuthAngle = home.theta - AZIMUTH_RANGE;
	controls.maxAzimuthAngle = home.theta + AZIMUTH_RANGE;
	controls.minPolarAngle = POLAR_MIN;
	controls.maxPolarAngle = POLAR_MAX;
	controls.minZoom = ZOOM_MIN;
	controls.maxZoom = ZOOM_MAX;
	controls.update();

	// --- On-demand rendering ---------------------------------------------------
	// No permanent loop: a frame is requested only when something changed, and the
	// chain of frames ends as soon as controls have settled and tweens are done.
	let raf = 0;
	let dirty = true;
	let shadowDirty = true; // the shadow maps are stale; set by anything that moves or changes a caster
	let disposed = false;
	let held = true; // the first render waits for the textures (see below)
	let colorTween: { start: number; from: Color[]; to: Color[] } | null = null;
	let cameraTween: { start: number; from: Spherical; zoom: number } | null = null;

	const schedule = () => {
		if (!raf && !disposed && !held) raf = requestAnimationFrame(frame);
	};
	// Scene or object changes (admin drag, setRoom object swap, model load) all come through here; orbit
	// and tweens only change the camera and colours, which do not move shadows.
	const invalidate = () => {
		dirty = true;
		shadowDirty = true;
		schedule();
	};

	const frame = (now: number) => {
		raf = 0;
		let tweening = false;

		const colors = colorTween;
		if (colors) {
			const t = MathUtils.clamp((now - colors.start) / TWEEN_MS, 0, 1);
			colorKeys.forEach((key, i) => {
				mats[key].color.lerpColors(colors.from[i], colors.to[i], ease(t));
			});
			syncWindowWood();
			if (t >= 1) colorTween = null;
			else tweening = true;
			dirty = true;
		}

		if (cameraTween) {
			const t = ease(MathUtils.clamp((now - cameraTween.start) / TWEEN_MS, 0, 1));
			const s = new Spherical(
				CAMERA_DISTANCE,
				MathUtils.lerp(cameraTween.from.phi, home.phi, t),
				MathUtils.lerp(cameraTween.from.theta, home.theta, t),
			);
			camera.position.setFromSpherical(s).add(TARGET);
			camera.zoom = MathUtils.lerp(cameraTween.zoom, 1, t);
			camera.updateProjectionMatrix();
			if (t >= 1) cameraTween = null;
			else tweening = true;
			dirty = true;
		}

		// update() applies damping and reports whether the camera moved; it also fires
		// 'change', which re-schedules the next frame while the motion lasts.
		const moved = controls.update();

		if (moved || dirty) {
			if (shadowDirty) {
				renderer.shadowMap.needsUpdate = true; // consumed by this render
				shadowDirty = false;
			}
			renderer.render(scene, camera);
			dirty = false;
		}
		if (moved || tweening) schedule();
	};

	// Wheel/pinch zoom is applied inside the controls' own update(), so the scheduled
	// frame's update() reports no movement; every 'change' must force a paint.
	const onControlsChange = () => {
		dirty = true;
		schedule();
	};
	// Grabbing the room cancels any ongoing return-to-home so the user wins.
	const onControlsStart = () => {
		cameraTween = null;
	};
	controls.addEventListener('change', onControlsChange);
	controls.addEventListener('start', onControlsStart);

	const frustum = (aspect: number) => {
		let halfW = fitHalfW;
		let halfH = fitHalfH;
		if (aspect >= halfW / halfH) halfW = halfH * aspect;
		else halfH = halfW / aspect;
		camera.left = -halfW;
		camera.right = halfW;
		camera.top = halfH;
		camera.bottom = -halfH;
		camera.updateProjectionMatrix();
	};

	const resize = () => {
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (!w || !h) return;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
		renderer.setSize(w, h, false); // false: leave the canvas CSS size to the layout
		frustum(w / h);
		dirty = true;
		schedule();
	};
	const observer = new ResizeObserver(resize);
	observer.observe(canvas);
	resize();

	const onContextLost = (event: Event) => event.preventDefault(); // allow restore
	const onContextRestored = () => {
		// GPU contents are gone: the environment map and the shadow maps must be rendered again.
		buildEnvironment();
		shadowDirty = true;
		dirty = true;
		schedule();
	};
	canvas.addEventListener('webglcontextlost', onContextLost);
	canvas.addEventListener('webglcontextrestored', onContextRestored);

	// --- Textures --------------------------------------------------------------
	// The first render is held until the maps are in or TEXTURE_WAIT_MS has passed (the canvas is transparent until then),
	// so a normal load shows no swap. After a timeout or an error the fallbacks are drawn and a late map is still swapped in.
	const loader = new TextureLoader();
	let warned = false;
	const warnOnce = (message: string, ...details: unknown[]) => {
		if (warned) return;
		warned = true;
		console.warn(message, ...details);
	};
	const loadMap = async (url: string, srgb: boolean) => {
		try {
			const texture = await loader.loadAsync(url);
			if (disposed) {
				texture.dispose();
				return null;
			}
			texture.wrapS = texture.wrapT = RepeatWrapping;
			texture.anisotropy = maxAnisotropy;
			if (srgb) texture.colorSpace = SRGBColorSpace;
			return texture;
		} catch (error) {
			if (!disposed) warnOnce(`Could not load the room texture ${url}; the plain material stays.`, error);
			return null;
		}
	};
	// A material's colour changes meaning when its maps arrive: set it again (a running tween would end on the old meaning).
	const recolor = () => {
		colorTween = null;
		applyColors(current.colors);
		invalidate();
	};
	const loadFloor = async () => {
		const [diffuse, rough] = await Promise.all([loadMap(OAK_DIFFUSE_URL, true), loadMap(OAK_ROUGHNESS_URL, false)]);
		if (disposed || !diffuse) {
			diffuse?.dispose();
			rough?.dispose();
			return;
		}
		diffuse.repeat.setScalar((2 * HALF) / FLOOR_TILE);
		rough?.repeat.copy(diffuse.repeat);
		fallbackFloorMap.dispose();
		floorTop.map = diffuse;
		floorTop.roughnessMap = rough;
		floorTop.roughness = rough ? OAK_ROUGHNESS : FLOOR_ROUGHNESS;
		floorTop.needsUpdate = true;
		oakFloor = true;
		recolor();
	};
	const loadWalls = async () => {
		const [detail, normal] = await Promise.all([
			loadMap(STUCCO_DETAIL_URL, true),
			coarsePointer ? null : loadMap(STUCCO_NORMAL_URL, false),
		]);
		if (disposed || !detail) {
			detail?.dispose();
			normal?.dispose();
			return;
		}
		for (const material of [mats.leftWall, mats.rightWall]) {
			material.map = detail;
			material.normalMap = normal;
			material.normalScale.setScalar(WALL_NORMAL_SCALE);
			material.needsUpdate = true;
		}
		stuccoWalls = true;
		recolor();
	};
	const release = () => {
		clearTimeout(waitTimer);
		if (!held || disposed) return;
		held = false;
		invalidate();
	};
	const waitTimer = setTimeout(() => {
		if (!held) return;
		warnOnce(`The room textures took over ${TEXTURE_WAIT_MS} ms; drawing the plain materials first.`);
		release();
	}, TEXTURE_WAIT_MS);
	void Promise.allSettled([loadFloor(), loadWalls()]).then((results) => {
		for (const result of results) {
			if (result.status === 'rejected') warnOnce('Could not apply the room textures.', result.reason);
		}
		release(); // whatever happened, the canvas is not left blank
	});

	schedule();

	return {
		scene,
		camera,
		renderer,
		controls,
		canvas,
		objects,
		invalidate,
		setRoom(config) {
			if (disposed) return;
			canvas.setAttribute('aria-label', ariaLabel(config));
			const same = colorKeys.every((key) => config.colors[key] === current.colors[key]);
			current = config;
			if (same) {
				dirty = true; // repaint after the canvas was moved in the DOM
				shadowDirty = true; // the shadow maps may have been dropped with the old context
				schedule();
				return;
			}

			const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			if (reduceMotion) {
				applyColors(config.colors);
				colorTween = null;
				cameraTween = null;
				camera.position.copy(TARGET).add(DEFAULT_OFFSET);
				camera.zoom = 1;
				camera.updateProjectionMatrix();
				controls.update();
				dirty = true;
				schedule();
				return;
			}

			// Flush leftover damping inertia so it cannot fight the ease-home.
			controls.enableDamping = false;
			controls.update();
			controls.enableDamping = true;

			const now = performance.now();
			colorTween = {
				start: now,
				from: colorKeys.map((key) => mats[key].color.clone()),
				to: colorKeys.map((key) => colorOf(key, config.colors[key])),
			};
			cameraTween = {
				start: now,
				from: new Spherical().setFromVector3(camera.position.clone().sub(TARGET)),
				zoom: camera.zoom,
			};
			schedule();
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			cancelAnimationFrame(raf);
			raf = 0;
			colorTween = null;
			cameraTween = null;
			clearTimeout(waitTimer);
			observer.disconnect();
			canvas.removeEventListener('webglcontextlost', onContextLost);
			canvas.removeEventListener('webglcontextrestored', onContextRestored);
			controls.removeEventListener('change', onControlsChange);
			controls.removeEventListener('start', onControlsStart);
			controls.dispose();
			objects.dispose();
			for (const light of lights) light.dispose(); // frees the shadow maps
			environment?.dispose();
			environment = null;
			scene.environment = null;
			floorTop.envMap = null; // the environment is freed above; disposeObject must not free its texture again
			disposeObject(scene); // shell, panes, glow and drop shadow: geometries, materials and their CanvasTextures
			scene.clear();
			renderer.dispose();
			renderer.forceContextLoss();
		},
	};
}
