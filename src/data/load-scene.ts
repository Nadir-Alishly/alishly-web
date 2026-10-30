// Build-time loader for src/data/scene.json (used by the Astro pages only, never shipped as a script).
// Bad data never fails the build: the files are read as text, so even syntactically broken JSON only
// produces a warning, and invalid objects and unknown rooms are dropped with a warning.
import rawText from './scene.json?raw';
import { models } from './models';
import { family } from './family';
import { parseScene } from './scene';
import type { ParseOptions, SceneData } from './scene';

export const parseOptions: ParseOptions = {
	slugs: family.map((member) => member.slug),
	modelIds: models.map((model) => model.id),
};

let raw: unknown = null;
try {
	raw = JSON.parse(rawText);
} catch {
	console.warn('[scene.json] is not valid JSON, so the rooms are built empty.');
}

const { scene, warnings } = parseScene(raw, parseOptions);
for (const warning of warnings) console.warn(`[scene.json] ${warning}`);

/** The committed scene, validated. Falls back to empty rooms. */
export const bundledScene: SceneData = scene;

/**
 * The same file for /admin: objects of a model that is not (or no longer) in models.json are kept
 * instead of dropped, so saving from the admin never deletes them. The public site still skips them.
 */
export const adminScene: SceneData = parseScene(raw, { slugs: parseOptions.slugs }).scene;
