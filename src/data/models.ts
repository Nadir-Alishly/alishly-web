// The GLTF model list (src/data/models.json), read as text so that a broken file cannot fail the
// build or the admin: it is parsed defensively and unusable entries are skipped.
import raw from './models.json?raw';
import { parseModels } from './scene';
import type { ModelEntry } from './scene';

function load(): ModelEntry[] {
	try {
		return parseModels(JSON.parse(raw));
	} catch {
		console.warn('[models.json] is not valid JSON, so no models are available.');
		return [];
	}
}

export const models: readonly ModelEntry[] = load();
