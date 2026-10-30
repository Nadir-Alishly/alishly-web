import {
	Box3,
	BoxGeometry,
	CanvasTexture,
	Color,
	DirectionalLight,
	HemisphereLight,
	MathUtils,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	MeshLambertMaterial,
	NeutralToneMapping,
	OrthographicCamera,
	PCFShadowMap,
	PlaneGeometry,
	PMREMGenerator,
	Scene,
	Spherical,
	SRGBColorSpace,
	Texture,
	Vector3,
	WebGLRenderer,
} from 'three';
import type { Material, Object3D, WebGLRenderTarget } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { RoomColors } from '../data/family';
import { ROOM_DIMS } from '../data/scene';
import { leftWallPieces, windowFrame } from '../data/room-window';
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
const { half: HALF, inner: INNER, wallHeight: WALL_HEIGHT, slab: SLAB, baseboard: BASEBOARD } = ROOM_DIMS;

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
const SUN_INTENSITY = 4.8; // about +60% on the floor patch over the shaded floor
const SUN_POSITION = new Vector3(...SUN_XYZ);
const SUN_MAP_SIZE = 2048; // 1024 on touch devices
const SUN_SHADOW_RADIUS = 4;
const SHADOW_MARGIN = 0.3;
const SHADOW_BIAS = -0.0004;
const SHADOW_NORMAL_BIAS = 0.03;
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

/** Vertical sky gradient with a few soft clouds, seen through the window. */
function skyTexture() {
	const canvas = document.createElement('canvas');
	canvas.width = 256;
	canvas.height = 128;
	const ctx = canvas.getContext('2d');
	if (ctx) {
		const gradient = ctx.createLinearGradient(0, 0, 0, 128);
		gradient.addColorStop(0, '#9fd0f4');
		gradient.addColorStop(0.65, '#d3e8f7');
		gradient.addColorStop(1, '#fbf1de');
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, 256, 128);
		for (const [x, y, r] of [
			[60, 50, 34],
			[96, 58, 26],
			[190, 82, 38],
			[150, 30, 22],
		]) {
			const cloud = ctx.createRadialGradient(x, y, 0, x, y, r);
			cloud.addColorStop(0, 'rgba(255,255,255,0.85)');
			cloud.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = cloud;
			ctx.fillRect(x - r, y - r, r * 2, r * 2);
		}
	}
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
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
	const box = new BoxGeometry(1, 1, 1); // shared; every part below is a scaled/moved copy
	const mats = {
		leftWall: new MeshLambertMaterial(),
		rightWall: new MeshLambertMaterial(),
		floor: new MeshLambertMaterial(),
		trim: new MeshLambertMaterial(),
	};
	const colorKeys = Object.keys(mats) as (keyof RoomColors)[];

	const part = (material: Material, min: Vector3, max: Vector3) => {
		const mesh = new Mesh(box, material);
		mesh.scale.subVectors(max, min);
		mesh.position.addVectors(min, max).multiplyScalar(0.5);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		scene.add(mesh);
		return mesh;
	};
	const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
	const partOf = (material: Material, b: { min: readonly number[]; max: readonly number[] }) =>
		part(material, v(b.min[0], b.min[1], b.min[2]), v(b.max[0], b.max[1], b.max[2]));

	// Floor slab, then the two back walls (-x on the left of the view, -z on the right).
	// The front sides are left out on purpose: that is the cut-away.
	part(mats.floor, v(-HALF, -SLAB, -HALF), v(HALF, 0, HALF));
	// The left wall has a window: four boxes around the opening, all in the wall colour.
	for (const piece of leftWallPieces(ROOM_DIMS)) partOf(mats.leftWall, piece);
	part(mats.rightWall, v(-INNER, 0, -HALF), v(HALF, WALL_HEIGHT, -INNER));
	// Thin caps on the wall tops in the wall colour. They neither cast nor receive shadows, so both tops read as the
	// same light band whatever the sun's shadow map does (see wallCaps). Looks only: the sun blocker below is still
	// needed. Not pickable: only `objects.root` is ray-tested.
	const caps = wallCaps(ROOM_DIMS);
	for (const [material, cap] of [[mats.leftWall, caps.left], [mats.rightWall, caps.right]] as const) {
		const mesh = partOf(material, cap);
		mesh.castShadow = false;
		mesh.receiveShadow = false;
	}
	// Baseboards along the foot of each wall.
	const { depth, height } = BASEBOARD;
	part(mats.trim, v(-INNER, 0, -INNER), v(-INNER + depth, height, HALF));
	part(mats.trim, v(-INNER + depth, 0, -INNER), v(HALF, height, -INNER + depth));

	// Window frame, muntins and sill share mats.trim, so they follow the room's trim colour for free.
	// The sky pane, glass and drop shadow have their own materials and stay out of `mats`: the colour
	// tween walks every key of `mats`.
	const win = windowFrame(ROOM_DIMS);
	for (const b of [win.sill, ...win.frame, ...win.muntins]) partOf(mats.trim, b);
	const { glazing } = win;
	// Opaque sky pane in the opening, so the page never shows through. It is slightly larger than the
	// opening and its edges hide inside the wall pieces. It does not cast shadows: the sun passes it.
	const sky = new Mesh(
		new PlaneGeometry(glazing.z1 - glazing.z0 + 0.5, glazing.y1 - glazing.y0 + 0.5),
		new MeshBasicMaterial({ map: skyTexture(), toneMapped: false }),
	);
	sky.rotation.y = Math.PI / 2; // normal +x, towards the room
	sky.position.set(glazing.skyX, (glazing.y0 + glazing.y1) / 2, (glazing.z0 + glazing.z1) / 2);
	scene.add(sky);
	// Faint glass over it.
	const glass = new Mesh(
		new PlaneGeometry(glazing.z1 - glazing.z0, glazing.y1 - glazing.y0),
		new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false, toneMapped: false }),
	);
	glass.rotation.y = Math.PI / 2;
	glass.position.set(glazing.glassX, sky.position.y, sky.position.z);
	scene.add(glass);

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
	const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
	const sunMapSize = coarsePointer ? 1024 : SUN_MAP_SIZE;
	const sunLight = shadowLight(SUN_COLOR, SUN_INTENSITY, SUN_POSITION, sunMapSize, SUN_SHADOW_RADIUS, sunBounds);
	const lights = [keyLight, sunLight];

	// Soft image-based ambient light. Optional: without it (no PMREM support) the scene just looks flatter.
	let environment: WebGLRenderTarget | null = null;
	const buildEnvironment = () => {
		environment?.dispose();
		environment = null;
		scene.environment = null;
		let generator: PMREMGenerator | null = null;
		let room: RoomEnvironment | null = null;
		let target: WebGLRenderTarget | null = null;
		try {
			generator = new PMREMGenerator(renderer);
			room = new RoomEnvironment();
			target = generator.fromScene(room, 0.04);
			scene.environment = target.texture;
			scene.environmentIntensity = ENV_INTENSITY;
			environment = target;
		} catch (error) {
			console.warn('Could not create the room environment light.', error);
			target?.dispose();
			scene.environment = null;
		} finally {
			room?.dispose();
			generator?.dispose();
		}
	};
	buildEnvironment();

	const applyColors = (colors: RoomColors) => {
		for (const key of colorKeys) mats[key].color.set(colors[key]);
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
	let colorTween: { start: number; from: Color[]; to: Color[] } | null = null;
	let cameraTween: { start: number; from: Spherical; zoom: number } | null = null;

	const schedule = () => {
		if (!raf && !disposed) raf = requestAnimationFrame(frame);
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
				to: colorKeys.map((key) => new Color(config.colors[key])),
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
			disposeObject(scene); // shell, sky, glass and drop shadow: geometries, materials and their CanvasTextures
			scene.clear();
			renderer.dispose();
			renderer.forceContextLoss();
		},
	};
}
