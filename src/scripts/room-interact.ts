// Public room pages: objects that carry a note (title + paragraph) react to the pointer.
//   - Hover (mouse only): the object floats up a little and gets a warm glow outline; cursor: pointer.
//   - Click / tap (a press that moved < CLICK_SLOP px, so not an orbit drag): selects it and opens a popup next to
//     it (a bottom sheet on narrow screens) with the title, the paragraph and a close button.
//   - A visually hidden list of buttons (one per note) opens the same popup for keyboard and screen-reader users.
// Only ever imported by room-scene.ts (public). The popup/list elements live in RoomScene.astro. Note text is put
// in with textContent / button text only, never as HTML.
//
// Rendering is on demand: animation steps run from the core's per-frame hook and paint with requestFrame() (no
// shadow refresh); invalidate() is called once when the float has settled. Nothing here loops while idle.
import { BackSide, BufferAttribute, BufferGeometry, Box3, Color, Mesh, Raycaster, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { Material, OrthographicCamera } from 'three';
import {
	advanceProgress,
	collectNotes,
	easeOutCubic,
	highlightedId,
	isClick,
	noteButtonLabel,
	placePopup,
	smoothNormals,
	SHEET_BREAKPOINT,
} from '../data/object-note';
import type { NoteEntry } from '../data/object-note';
import type { SceneObject } from '../data/scene';
import type { RoomCore } from './room-core';
import { catalogEntry } from './room-objects';

/** A press that moves less than this (px) is a click; more is an orbit drag. */
export const CLICK_SLOP = 5;
/** How high a highlighted object floats (world units) and how long that takes. */
export const FLOAT_HEIGHT = 0.08;
export const FLOAT_MS = 200;
/** Warm amber glow (sRGB 0..1), as two shells: a soft wide one and a tighter bright one. */
const GLOW_RGB: [number, number, number] = [0.96, 0.62, 0.04];
const GLOW_LAYERS = [
	{ px: 7, opacity: 0.2 },
	{ px: 3, opacity: 0.85 },
] as const;
/** The object's own materials get this much amber emissive while highlighted (a slight brighten). */
const BRIGHTEN = new Color('#ffb020').multiplyScalar(0.16);
/** Geometries with more vertices than this are not smoothed for the shell (they use their own normals). */
const SMOOTH_MAX_VERTICES = 30000;
const SETTLE_MS = 140;
const POPUP_MARGIN = 8;
const POPUP_GAP = 12;
const POPUP_MAX_HEIGHT = 384;

export interface RoomInteract {
	/** Drop the highlight, float and popup (before the objects are swapped). */
	clear(): void;
	/** The room now has these objects: rebuild what is interactive and the keyboard list. Clears first. */
	setObjects(objects: readonly SceneObject[]): void;
	/** Release every listener, timer, shell and DOM leftover. Safe to call more than once. */
	dispose(): void;
}

const NOOP: RoomInteract = { clear() {}, setObjects() {}, dispose() {} };

interface Shell {
	meshes: Mesh[];
	/** Emissive colours that were replaced, to put back. */
	emissive: { material: Material & { emissive: Color }; color: Color }[];
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const GLOW_VERTEX = /* glsl */ `
	uniform float uExtrude;
	void main() {
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		vec2 d = (normalMatrix * normal).xy;
		float l = length(d);
		if (l > 1e-4) mv.xy += d / l * uExtrude;
		gl_Position = projectionMatrix * mv;
	}
`;
const GLOW_FRAGMENT = /* glsl */ `
	uniform vec3 uColor;
	uniform float uOpacity;
	void main() { gl_FragColor = vec4(uColor, uOpacity); }
`;

export function createRoomInteract(core: RoomCore, canvas: HTMLCanvasElement): RoomInteract {
	const host = canvas.parentElement;
	const popup = host?.querySelector<HTMLElement>('[data-note-popup]') ?? null;
	const layer = host?.querySelector<HTMLElement>('[data-note-layer]') ?? null;
	const list = host?.querySelector<HTMLElement>('[data-note-list]') ?? null;
	const closeButton = popup?.querySelector<HTMLButtonElement>('[data-note-close]') ?? null;
	const body = popup?.querySelector<HTMLElement>('[data-note-body]') ?? null;
	const titleEl = popup?.querySelector<HTMLElement>('[data-note-title]') ?? null;
	const textEl = popup?.querySelector<HTMLElement>('[data-note-text]') ?? null;
	if (!host || !popup || !layer || !list || !closeButton || !body || !titleEl || !textEl) return NOOP;

	let disposed = false;
	let notes = new Map<string, NoteEntry>();
	let hoverId: string | null = null;
	let selectedId: string | null = null;
	let shownId: string | null = null; // the object that currently has the glow
	let shell: Shell | null = null;
	let opener: HTMLButtonElement | null = null;

	// Float: per object a 0..1 progress, moved towards 1 for the highlighted object and 0 for the others.
	const progress = new Map<string, number>();
	let lastNow = 0;
	let shadowStale = false;

	const raycaster = new Raycaster();
	const ndc = new Vector2();
	const pointer = { x: 0, y: 0, inside: false, mouse: false };
	let hoverFrame = 0;
	let settleTimer = 0;
	let cameraMoving = false;

	// --- Highlight (glow + float) -----------------------------------------------------------------

	// The shell's materials (one per glow layer) and the smoothed geometries are made once and reused for every
	// highlight; the geometries are freed when the room changes (clear) and everything on dispose.
	let glowMaterials: ShaderMaterial[] | null = null;
	const shellGeometries = new Map<BufferGeometry, BufferGeometry>();

	function materials(): ShaderMaterial[] {
		glowMaterials ??= GLOW_LAYERS.map(({ opacity }) =>
			new ShaderMaterial({
				uniforms: {
					uExtrude: { value: 0 },
					uColor: { value: new Vector3(...GLOW_RGB) },
					uOpacity: { value: opacity },
				},
				vertexShader: GLOW_VERTEX,
				fragmentShader: GLOW_FRAGMENT,
				side: BackSide, // only the far faces, which peek out around the object
				transparent: true,
				depthWrite: false,
			}),
		);
		return glowMaterials;
	}

	function buildShell(id: string): Shell | null {
		const holder = core.objects.get(id);
		if (!holder) return null;
		const next: Shell = { meshes: [], emissive: [] };
		const sources: Mesh[] = [];
		holder.traverse((node) => {
			const mesh = node as Mesh;
			if (mesh.isMesh && mesh.geometry && !mesh.userData.isGlowShell) sources.push(mesh);
		});
		const layers = materials();
		for (const source of sources) {
			let geometry = shellGeometries.get(source.geometry);
			if (!geometry) {
				geometry = shellGeometry(source.geometry);
				shellGeometries.set(source.geometry, geometry);
			}
			GLOW_LAYERS.forEach(({ px }, i) => {
				const mesh = new Mesh(geometry, layers[i]);
				mesh.userData.isGlowShell = true;
				mesh.castShadow = false;
				mesh.receiveShadow = false;
				mesh.renderOrder = 10 + i;
				mesh.raycast = () => {}; // the shell must never be picked
				mesh.onBeforeRender = (renderer, _scene, camera) => {
					// Pixel-constant thickness: view units per CSS pixel for the orthographic camera.
					const ortho = camera as OrthographicCamera;
					const height = renderer.domElement.clientHeight || 1;
					const perPx = ortho.isOrthographicCamera ? (ortho.top - ortho.bottom) / (ortho.zoom || 1) / height : 0.01;
					layers[i].uniforms.uExtrude.value = px * perPx;
					layers[i].uniformsNeedUpdate = true;
				};
				source.add(mesh);
				next.meshes.push(mesh);
			});
			// A slight brighten of the object's own materials.
			const own = Array.isArray(source.material) ? source.material : [source.material];
			for (const material of own) {
				const emissive = (material as Partial<{ emissive: Color }>).emissive;
				if (!emissive || next.emissive.some((e) => e.material === material)) continue;
				next.emissive.push({ material: material as Material & { emissive: Color }, color: emissive.clone() });
				emissive.add(BRIGHTEN);
			}
		}
		return next;
	}

	/** The geometry the shell uses: same positions, normals smoothed across the hard edges (corners stay closed). */
	function shellGeometry(source: BufferGeometry): BufferGeometry {
		const position = source.getAttribute('position');
		const normal = source.getAttribute('normal');
		if (!position || !normal || position.count > SMOOTH_MAX_VERTICES) return source;
		const geometry = new BufferGeometry();
		const positions = new Float32Array(position.count * 3);
		const normals = new Float32Array(position.count * 3);
		for (let i = 0; i < position.count; i++) {
			positions[i * 3] = position.getX(i);
			positions[i * 3 + 1] = position.getY(i);
			positions[i * 3 + 2] = position.getZ(i);
			normals[i * 3] = normal.getX(i);
			normals[i * 3 + 1] = normal.getY(i);
			normals[i * 3 + 2] = normal.getZ(i);
		}
		geometry.setAttribute('position', position); // shared buffer: no new GPU memory for the vertices
		geometry.setIndex(source.getIndex());
		geometry.setAttribute('normal', new BufferAttribute(smoothNormals(positions, normals), 3));
		return geometry;
	}

	function destroyShell() {
		if (!shell) return;
		for (const mesh of shell.meshes) mesh.removeFromParent();
		for (const { material, color } of shell.emissive) material.emissive.copy(color);
		shell = null;
	}

	/** Frees the cached shell geometries (the objects they were made from are about to go, or the scene is closing). */
	function releaseShellCache() {
		for (const [source, geometry] of shellGeometries) {
			if (geometry === source) continue;
			// The vertices and indices belong to the object: detach them so dispose() frees only the normals.
			geometry.deleteAttribute('position');
			geometry.setIndex(null);
			geometry.dispose();
		}
		shellGeometries.clear();
	}

	function setHighlight(id: string | null) {
		if (id === shownId) return;
		const previous = shownId;
		shownId = id;
		destroyShell();
		if (id !== null) shell = buildShell(id);
		if (!reducedMotion()) {
			if (previous !== null && !progress.has(previous)) progress.set(previous, 1);
			if (id !== null && !progress.has(id)) progress.set(id, 0);
		}
		canvas.style.cursor = hoverId !== null ? 'pointer' : '';
		core.requestFrame();
	}

	/** Re-derives the highlight from hover/selection ("hover takes over"; never more than one). */
	function applyHighlight() {
		setHighlight(highlightedId(hoverId, selectedId));
		canvas.style.cursor = hoverId !== null ? 'pointer' : '';
	}

	/** Core per-frame hook: float steps and popup follow. Returns true while the float is still moving. */
	function onFrame(now: number): boolean {
		const dt = lastNow ? Math.min(now - lastNow, 64) : 16;
		lastNow = now;
		let animating = false;
		let changed = false;
		const reduced = reducedMotion();
		for (const [id, value] of progress) {
			const target = id === shownId && !reduced ? 1 : 0;
			if (value === target) {
				if (target === 0) progress.delete(id);
				continue;
			}
			const next = advanceProgress(value, target, dt, reduced ? 0 : FLOAT_MS); // reduced motion: snap, never ease
			core.objects.setLift(id, FLOAT_HEIGHT * easeOutCubic(next));
			changed = shadowStale = true;
			progress.set(id, next);
			if (next !== target) animating = true;
		}
		if (changed) core.requestFrame();
		if (!animating) {
			lastNow = 0;
			if (shadowStale) {
				shadowStale = false;
				core.invalidate(); // the shadows catch up once, at the final height
			}
		}
		if (selectedId !== null) positionPopup();
		return animating;
	}

	// --- Popup ----------------------------------------------------------------------------------------

	const wide = window.matchMedia(`(min-width: ${SHEET_BREAKPOINT}px)`);
	let naturalHeight = 0;
	let popupWidth = 0;
	let measuredFor = '';
	let anchorBox: Box3 | null = null; // the selected object's world box at rest (camera independent)
	const corner = new Vector3();
	// The canvas area, kept up to date by a ResizeObserver so the per-frame positioning reads no layout.
	const area = { width: layer.clientWidth, height: layer.clientHeight };
	// What was last written to the popup's style, to skip identical writes.
	const written = { transform: '', maxHeight: '', hidden: false };

	function restBox(id: string): Box3 | null {
		const holder = core.objects.get(id);
		if (!holder) return null;
		const box = new Box3().setFromObject(holder);
		if (box.isEmpty()) return null;
		const lift = FLOAT_HEIGHT * easeOutCubic(progress.get(id) ?? 0);
		box.min.y -= lift;
		box.max.y -= lift;
		return box;
	}

	function measure() {
		popup!.style.maxHeight = 'none';
		naturalHeight = Math.min(popup!.offsetHeight, POPUP_MAX_HEIGHT);
		popupWidth = popup!.offsetWidth;
		measuredFor = `${area.width}x${area.height}|${selectedId}`;
		popup!.style.maxHeight = '';
		written.maxHeight = '';
	}

	const write = (key: 'transform' | 'maxHeight', value: string) => {
		if (written[key] === value) return;
		written[key] = value;
		popup!.style[key] = value;
	};
	const setHiddenByPosition = (hide: boolean) => {
		if (written.hidden === hide) return;
		written.hidden = hide;
		popup!.style.visibility = hide ? 'hidden' : '';
	};

	function positionPopup() {
		if (selectedId === null || popup!.hidden) return;
		const { width, height } = area;
		if (!width || !height) return;
		const sheet = !wide.matches;
		const layout = sheet ? 'sheet' : 'float';
		if (popup!.dataset.layout !== layout) {
			popup!.dataset.layout = layout;
			measuredFor = '';
		}
		if (sheet) {
			write('transform', '');
			write('maxHeight', `${Math.round(height * 0.55)}px`);
			setHiddenByPosition(false);
			popup!.dataset.placement = 'sheet';
			return;
		}
		if (measuredFor !== `${width}x${height}|${selectedId}`) measure();
		if (!anchorBox || anchorBox.isEmpty()) anchorBox = restBox(selectedId); // a model that has just loaded
		const lift = FLOAT_HEIGHT * easeOutCubic(progress.get(selectedId) ?? 0);
		// Project the object's box. Its screen-space extent is the anchor; the bottom edge is the mean of the base's
		// centre and its lowest corner, because the box's front-bottom corner sits well below a tall object's visible foot.
		core.camera.updateMatrixWorld();
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		let baseLow = -Infinity;
		let fullMaxY = -Infinity;
		const project = (x: number, y: number, z: number) => {
			corner.set(x, y, z).project(core.camera);
			return [((corner.x + 1) / 2) * width, ((1 - corner.y) / 2) * height] as const;
		};
		const box = anchorBox;
		if (box) {
			for (const x of [box.min.x, box.max.x]) {
				for (const y of [box.min.y, box.max.y]) {
					for (const z of [box.min.z, box.max.z]) {
						const [sx, sy] = project(x, y + lift, z);
						minX = Math.min(minX, sx);
						maxX = Math.max(maxX, sx);
						minY = Math.min(minY, sy);
						maxY = Math.max(maxY, sy);
						if (y === box.min.y) baseLow = Math.max(baseLow, sy);
					}
				}
			}
			const [, baseCentre] = project((box.min.x + box.max.x) / 2, box.min.y + lift, (box.min.z + box.max.z) / 2);
			fullMaxY = maxY;
			maxY = (baseCentre + baseLow) / 2;
		} else {
			const holder = core.objects.get(selectedId);
			if (!holder) return;
			const [sx, sy] = project(holder.position.x, holder.position.y, holder.position.z);
			minX = maxX = sx;
			minY = maxY = sy;
		}
		// Fully outside the canvas (strong zoom/orbit): nothing to point at, so the popup waits out of sight.
		// A note opened from the keyboard list stays visible (clamped to the canvas edge): its ✕ must be focusable.
		const offscreen = opener === null && !!box && (maxX < 0 || minX > width || fullMaxY < 0 || minY > height);
		setHiddenByPosition(offscreen);
		if (offscreen) return;
		const anchor = {
			x: Math.min(Math.max((minX + maxX) / 2, 0), width),
			top: Math.min(Math.max(minY, 0), height),
			bottom: Math.min(Math.max(maxY, 0), height),
		};
		const placed = placePopup({
			anchor,
			size: { width: popupWidth, height: naturalHeight },
			bounds: { width, height },
			margin: POPUP_MARGIN,
			gap: POPUP_GAP,
		});
		write('maxHeight', `${Math.floor(placed.height)}px`);
		write('transform', `translate(${Math.round(placed.left)}px, ${Math.round(placed.top)}px)`);
		popup!.dataset.placement = placed.placement;
	}

	function openPopup(entry: NoteEntry, label: string) {
		const wasOpen = !popup!.hidden;
		textEl!.textContent = entry.paragraph;
		titleEl!.textContent = entry.title ?? '';
		titleEl!.hidden = entry.title === null;
		if (entry.title === null) {
			popup!.removeAttribute('aria-labelledby');
			popup!.setAttribute('aria-label', `${label} note`);
		} else {
			popup!.removeAttribute('aria-label');
			popup!.setAttribute('aria-labelledby', 'note-heading');
		}
		body!.scrollTop = 0;
		popup!.hidden = false;
		measuredFor = '';
		anchorBox = restBox(entry.id);
		area.width = layer!.clientWidth;
		area.height = layer!.clientHeight;
		positionPopup();
		if (!wasOpen && !reducedMotion() && typeof popup!.animate === 'function') {
			popup!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
		}
	}

	/**
	 * `returnFocus`: the user closed it from the keyboard (Esc, ✕ via keyboard). Focus then goes back to the list button
	 * that opened the note, and only to that one. If focus was merely inside the popup (a click on the text, Tab into it)
	 * it is released to the page, so the hidden list never becomes visible. Mouse closes never move focus to a list
	 * button. `silent` is for clear()/dispose: no focus change, no hover re-pick.
	 */
	function closePopup(returnFocus: boolean, silent = false) {
		const had = selectedId;
		const focusInside = popup!.contains(document.activeElement);
		selectedId = null;
		anchorBox = null;
		popup!.hidden = true;
		popup!.style.transform = '';
		popup!.style.maxHeight = '';
		popup!.style.visibility = '';
		written.transform = '';
		written.maxHeight = '';
		written.hidden = false;
		textEl!.textContent = '';
		titleEl!.textContent = '';
		const target = opener ?? (had !== null ? buttonFor(had) : null);
		// Only the list button that opened the note gets focus back (it is the one thing keyboard users can return to).
		// Focus that was merely inside the popup (e.g. a click on the text) is released to the page without revealing the list.
		const shouldFocus = !silent && returnFocus && opener !== null;
		opener = null;
		if (shouldFocus) target?.focus();
		else if (!silent && focusInside && document.activeElement instanceof HTMLElement) document.activeElement.blur();
		applyHighlight();
		if (!silent && pointer.inside && pointer.mouse) scheduleHover(); // the mouse may still rest on the object
	}

	function select(id: string, from: HTMLButtonElement | null) {
		const entry = notes.get(id);
		if (!entry) return;
		selectedId = id;
		opener = from;
		const label = catalogEntry(core.objects.get(id)?.userData.type as string)?.label ?? 'Object';
		openPopup(entry, label);
		applyHighlight();
		core.requestFrame();
		if (from) closeButton!.focus(); // keyboard: move into the popup
	}

	// --- Keyboard list --------------------------------------------------------------------------------

	const buttons = new Map<string, HTMLButtonElement>();
	const buttonFor = (id: string) => buttons.get(id) ?? null;

	function rebuildList() {
		list!.replaceChildren();
		buttons.clear();
		for (const entry of notes.values()) {
			const item = document.createElement('li');
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = noteButtonLabel(entry);
			button.className =
				'sr-only focus:not-sr-only focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:text-stone-900 focus:shadow-sm focus:ring-1 focus:ring-stone-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900';
			button.addEventListener('click', () => select(entry.id, button));
			item.append(button);
			list!.append(item);
			buttons.set(entry.id, button);
		}
		list!.hidden = notes.size === 0;
	}

	// --- Pointer ------------------------------------------------------------------------------------

	function pick(clientX: number, clientY: number): string | null {
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
		raycaster.setFromCamera(ndc, core.camera);
		return core.objects.idAt(raycaster);
	}

	function setHover(id: string | null) {
		const next = id !== null && notes.has(id) ? id : null;
		if (next === hoverId) return;
		hoverId = next;
		applyHighlight();
	}

	function pickHover() {
		hoverFrame = 0;
		if (disposed || !pointer.inside || !pointer.mouse || cameraMoving) return;
		setHover(pick(pointer.x, pointer.y));
	}

	function scheduleHover() {
		if (!hoverFrame) hoverFrame = requestAnimationFrame(pickHover);
	}

	const onPointerMove = (event: PointerEvent) => {
		pointer.x = event.clientX;
		pointer.y = event.clientY;
		pointer.mouse = event.pointerType === 'mouse';
		pointer.inside = true;
		if (!pointer.mouse) return;
		if (event.buttons !== 0) {
			// A drag (pointer capture keeps the moves coming to the canvas): no hover while orbiting.
			setHover(null);
			return;
		}
		scheduleHover();
	};
	const onPointerLeave = (event: PointerEvent) => {
		if (event.pointerType !== 'mouse') return;
		pointer.inside = false;
		setHover(null);
	};

	// Click detection: one pointer, moved < CLICK_SLOP, primary button.
	const active = new Set<number>();
	let press: { id: number; x: number; y: number; valid: boolean } | null = null;
	const onPointerDown = (event: PointerEvent) => {
		active.add(event.pointerId);
		if (active.size > 1) {
			if (press) press.valid = false; // a second finger: pinch/rotate, not a tap
			return;
		}
		press = { id: event.pointerId, x: event.clientX, y: event.clientY, valid: event.button === 0 };
	};
	const onPointerUp = (event: PointerEvent) => {
		active.delete(event.pointerId);
		const start = press;
		if (start && start.id === event.pointerId) press = null;
		if (!start || start.id !== event.pointerId || !start.valid || event.button !== 0) return;
		if (!isClick(start, { x: event.clientX, y: event.clientY }, CLICK_SLOP)) return;
		const id = pick(event.clientX, event.clientY);
		if (id !== null && notes.has(id)) {
			if (id !== selectedId) select(id, null);
		} else if (selectedId !== null) {
			closePopup(false);
		}
	};
	const onPointerCancel = (event: PointerEvent) => {
		active.delete(event.pointerId);
		if (press && press.id === event.pointerId) press = null;
	};

	// The camera moved (drag, wheel, damping, room tween): no hover until it has been still for a moment.
	const onCameraChange = () => {
		cameraMoving = true;
		setHover(null);
		clearTimeout(settleTimer);
		settleTimer = window.setTimeout(() => {
			cameraMoving = false;
			if (!disposed && pointer.inside && pointer.mouse && !active.size) scheduleHover();
		}, SETTLE_MS);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && selectedId !== null) {
			event.preventDefault();
			closePopup(true);
		}
	};
	const onClose = (event: MouseEvent) => closePopup(event.detail === 0); // detail 0 = keyboard activation
	const onSheetChange = () => {
		measuredFor = '';
		positionPopup();
	};

	canvas.addEventListener('pointermove', onPointerMove);
	canvas.addEventListener('pointerleave', onPointerLeave);
	canvas.addEventListener('pointerdown', onPointerDown);
	canvas.addEventListener('pointerup', onPointerUp);
	canvas.addEventListener('pointercancel', onPointerCancel);
	core.controls.addEventListener('change', onCameraChange);
	document.addEventListener('keydown', onKeyDown);
	closeButton.addEventListener('click', onClose);
	wide.addEventListener('change', onSheetChange);
	const areaObserver = new ResizeObserver(() => {
		area.width = layer.clientWidth;
		area.height = layer.clientHeight;
		measuredFor = '';
		if (selectedId !== null) core.requestFrame(); // the hook re-places the popup
	});
	areaObserver.observe(layer);
	core.setFrameHook(onFrame);
	core.objects.onLoad = (id) => {
		if (id === selectedId) {
			anchorBox = restBox(id);
			core.requestFrame();
		}
		if (id === shownId) {
			// The model arrived after the highlight started: give it its glow now.
			const again = shownId;
			shownId = null;
			setHighlight(again);
		}
	};

	function clear() {
		hoverId = null;
		if (selectedId !== null || !popup!.hidden) closePopup(false, true);
		else applyHighlight();
		setHighlight(null);
		releaseShellCache();
		// Back to rest at once (the objects may be about to be replaced).
		for (const id of progress.keys()) core.objects.setLift(id, 0);
		progress.clear();
		lastNow = 0;
		if (shadowStale) {
			shadowStale = false;
			core.invalidate();
		}
		canvas.style.cursor = '';
	}

	return {
		clear,
		setObjects(objects) {
			if (disposed) return;
			clear();
			notes = new Map(collectNotes(objects, (type) => catalogEntry(type)?.label).map((entry) => [entry.id, entry]));
			rebuildList();
		},
		dispose() {
			if (disposed) return;
			clear();
			disposed = true;
			cancelAnimationFrame(hoverFrame);
			clearTimeout(settleTimer);
			canvas.removeEventListener('pointermove', onPointerMove);
			canvas.removeEventListener('pointerleave', onPointerLeave);
			canvas.removeEventListener('pointerdown', onPointerDown);
			canvas.removeEventListener('pointerup', onPointerUp);
			canvas.removeEventListener('pointercancel', onPointerCancel);
			core.controls.removeEventListener('change', onCameraChange);
			document.removeEventListener('keydown', onKeyDown);
			closeButton.removeEventListener('click', onClose);
			wide.removeEventListener('change', onSheetChange);
			core.setFrameHook(null);
			core.objects.onLoad = null;
			areaObserver.disconnect();
			for (const material of glowMaterials ?? []) material.dispose();
			glowMaterials = null;
			list.replaceChildren();
			buttons.clear();
			popup.hidden = true;
			delete popup.dataset.layout;
			delete popup.dataset.placement;
		},
	};
}
