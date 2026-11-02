// Screen-space ambient occlusion for the whole room (settings.ao). LAZY: room-core loads this module with import() only
// when ao.intensity > 0, like GLTFLoader, so rooms with AO off never download it (or three's GTAO addon).
//
// It is an OVERLAY: the normal render to the canvas (MSAA, tone mapping, the `toneMapped: false` window glow) is untouched.
// Afterwards the addon's GTAOPass computes the occlusion at HALF resolution into its own target (normal pass + GTAO +
// denoise; the pass is run with output Off so it writes nothing to the canvas), and one full-screen quad multiplies it onto
// the canvas. The multiply keeps the canvas alpha (blend: colour x destination colour, alpha untouched), so the transparent
// background stays transparent, and background pixels have AO = 1 (GTAO discards them).
//
// Non-occluders: anything whose `userData.noAo` is true (the shadow blocker, drop-shadow plane, halo, pool, window pane, the
// highlight glow shells, the admin's gizmo/selection box and import ghost) is hidden for the normal pass and restored right
// after. Mark a new helper mesh with `mesh.userData.noAo = true`; that flag is the one list. Meshes whose materials are all
// see-through (blended/transparent such as foliage cards and glass, alpha-tested, transmissive) are hidden too: the normal
// pass draws every mesh as a solid card, which would make a leaf card's transparent texels occlude (and shade as AO = 1)
// the wall seen through them: a pale fringe round foliage and dark halos beside it. Those meshes get the AO of whatever
// is behind them.
//
// Quality: `lowQuality` (touch devices) computes at quarter resolution with 8 samples instead of half resolution and 16.
//
// Cost control: the (expensive) AO is recomputed only when the scene revision, the camera or the radius changed; a repaint
// for a hover highlight only re-runs the cheap multiply with the previous result.
import { AddEquation, Color, CustomBlending, DoubleSide, DstColorFactor, OneFactor, ShaderMaterial, ZeroFactor } from 'three';
import type { Camera, Material, Mesh, Object3D, Scene, WebGLRenderer } from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export interface AoOverlay {
	/** The canvas' drawing-buffer size in pixels; the AO itself is computed at half of it. Invalidates the result. */
	setSize(width: number, height: number): void;
	/** Draws the AO onto the canvas; call right after the main render. `rev` changes whenever the scene's geometry changed. */
	render(intensity: number, radius: number, rev: number): void;
	/** Frees the targets, materials and quad. Safe to call twice. */
	dispose(): void;
}

/** True for a material the normal pass would wrongly draw as solid: blended, alpha-tested or transmissive. */
export function isSeeThrough(material: Material): boolean {
	const m = material as Material & { transmission?: number };
	return m.transparent || m.alphaTest > 0 || (m.transmission ?? 0) > 0;
}

/** True when the mesh must not occlude: flagged `userData.noAo`, or all its materials are see-through. */
function isNonOccluder(object: Object3D): boolean {
	if (object.userData.noAo === true) return true;
	const { material } = object as Partial<Mesh>;
	if (!material) return false;
	const list = Array.isArray(material) ? material : [material];
	return list.length > 0 && list.every(isSeeThrough);
}

export function createAoOverlay(
	renderer: WebGLRenderer,
	scene: Scene,
	camera: Camera,
	width: number,
	height: number,
	lowQuality = false,
): AoOverlay {
	const divisor = lowQuality ? 4 : 2;
	const scaled = (n: number) => Math.max(1, Math.floor(n / divisor));
	const pass = new GTAOPass(scene, camera, scaled(width), scaled(height));
	pass.output = GTAOPass.OUTPUT.Off; // compute only: the canvas gets the multiply below
	pass.updateGtaoMaterial({ radius: 0.5, thickness: 1, distanceFallOff: 1, scale: 1, samples: lowQuality ? 8 : 16 });
	pass.normalMaterial.side = DoubleSide; // double-sided thin meshes (most glTF) are seen from either side, not culled into holes

	const material = new ShaderMaterial({
		uniforms: { tAo: { value: pass.gtaoMap }, intensity: { value: 0.5 } },
		vertexShader: /* glsl */ `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}`,
		fragmentShader: /* glsl */ `
			uniform sampler2D tAo;
			uniform float intensity;
			varying vec2 vUv;
			void main() {
				gl_FragColor = vec4(vec3(mix(1.0, texture2D(tAo, vUv).r, intensity)), 1.0);
			}`,
		transparent: true,
		depthTest: false,
		depthWrite: false,
		toneMapped: false,
		blending: CustomBlending,
		blendEquation: AddEquation,
		blendSrc: DstColorFactor, // colour = ao x canvas colour
		blendDst: ZeroFactor,
		blendEquationAlpha: AddEquation,
		blendSrcAlpha: ZeroFactor, // alpha = canvas alpha, untouched
		blendDstAlpha: OneFactor,
	});
	const quad = new FullScreenQuad(material);

	let key = ''; // what the stored AO was computed for; '' = nothing valid
	let disposed = false;
	const hidden: Object3D[] = [];
	const clearColor = new Color();

	const hideNonOccluders = () => {
		scene.traverse((object) => {
			if (object.visible && isNonOccluder(object)) {
				object.visible = false;
				hidden.push(object);
			}
		});
	};
	const restoreNonOccluders = () => {
		for (const object of hidden) object.visible = true;
		hidden.length = 0;
	};

	return {
		setSize(w, h) {
			if (disposed) return;
			pass.setSize(scaled(w), scaled(h));
			key = '';
		},
		render(intensity, radius, rev) {
			if (disposed) return;
			camera.updateMatrixWorld();
			const next = `${rev}|${radius}|${camera.matrixWorld.elements.join()}|${camera.projectionMatrix.elements.join()}`;
			const autoClear = renderer.autoClear;
			const previousTarget = renderer.getRenderTarget();
			renderer.getClearColor(clearColor);
			const clearAlpha = renderer.getClearAlpha();
			try {
				if (next !== key) {
					pass.updateGtaoMaterial({ radius });
					hideNonOccluders();
					try {
						pass.render(renderer, null as never, null as never);
					} finally {
						restoreNonOccluders();
					}
					key = next;
				}
				material.uniforms.intensity.value = intensity;
				renderer.setRenderTarget(previousTarget); // the pass leaves its own target bound (normally the canvas, null)
				renderer.autoClear = false;
				quad.render(renderer);
			} finally {
				// GTAOPass restores these only when it succeeds; a throw must not leave the room drawn with the normal material
				// or with an opaque blue clear colour (the canvas is transparent).
				scene.overrideMaterial = null;
				renderer.setClearColor(clearColor, clearAlpha);
				renderer.autoClear = autoClear;
				renderer.setRenderTarget(previousTarget);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			restoreNonOccluders();
			quad.dispose();
			material.dispose();
			pass.dispose();
			pass.gtaoMaterial.dispose(); // not freed by GTAOPass.dispose()
			pass.blendMaterial.dispose();
		},
	};
}
