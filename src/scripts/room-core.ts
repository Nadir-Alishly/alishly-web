import {
	BoxGeometry,
	Color,
	DirectionalLight,
	HemisphereLight,
	MathUtils,
	Mesh,
	MeshLambertMaterial,
	OrthographicCamera,
	Scene,
	Spherical,
	Texture,
	Vector3,
	WebGLRenderer,
} from 'three';
import type { Material, Object3D } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RoomColors } from '../data/family';
import { ROOM_DIMS } from '../data/scene';
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
 * The room shell (floor, walls, lights), camera, orbit controls, on-demand render loop and the
 * object manager, shared by the public viewer (room-scene.ts) and the admin editor.
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

	const part = (material: MeshLambertMaterial, min: Vector3, max: Vector3) => {
		const mesh = new Mesh(box, material);
		mesh.scale.subVectors(max, min);
		mesh.position.addVectors(min, max).multiplyScalar(0.5);
		scene.add(mesh);
	};
	const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

	// Floor slab, then the two back walls (-x on the left of the view, -z on the right).
	// The front sides are left out on purpose: that is the cut-away.
	part(mats.floor, v(-HALF, -SLAB, -HALF), v(HALF, 0, HALF));
	part(mats.leftWall, v(-HALF, 0, -HALF), v(-INNER, WALL_HEIGHT, HALF));
	part(mats.rightWall, v(-INNER, 0, -HALF), v(HALF, WALL_HEIGHT, -INNER));
	// Baseboards along the foot of each wall.
	const { depth, height } = BASEBOARD;
	part(mats.trim, v(-INNER, 0, -INNER), v(-INNER + depth, height, HALF));
	part(mats.trim, v(-INNER + depth, 0, -INNER), v(HALF, height, -INNER + depth));

	const objects = createObjectManager(() => invalidate());
	scene.add(objects.root);

	scene.add(new HemisphereLight(0xffffff, 0xcfc8c0, 1.4));
	const sun = new DirectionalLight(0xffffff, 2);
	sun.position.set(5, 9, 7);
	scene.add(sun);

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
	let disposed = false;
	let colorTween: { start: number; from: Color[]; to: Color[] } | null = null;
	let cameraTween: { start: number; from: Spherical; zoom: number } | null = null;

	const schedule = () => {
		if (!raf && !disposed) raf = requestAnimationFrame(frame);
	};
	const invalidate = () => {
		dirty = true;
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
			disposeObject(scene);
			scene.clear();
			renderer.dispose();
			renderer.forceContextLoss();
		},
	};
}
