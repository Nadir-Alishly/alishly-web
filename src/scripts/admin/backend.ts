// What the admin tells the user about WHERE it saves. The default is the GitHub wording (what production shows);
// the dev-only local backend (local-client.ts, loaded only by `astro dev`) brings its own. Pure TypeScript with only
// erasable syntax and no DOM/three/Astro imports, so Node can import it directly.

export interface Wording {
	/** Completes "on …" / "from …" in messages: "GitHub" or "disk". */
	where: string;
	/** Status after "Load latest". */
	loaded: string;
	/** Status after the scene was saved. */
	sceneSaved: string;
	/** Status when "Save models" had nothing to write. */
	modelsUpToDate: string;
	/** Status after a model was imported (it is only staged until "Save models"). */
	modelAdded(label: string): string;
	/** Status after "Save models"; `summary` is e.g. "1 added, 2 deleted" (empty when there is nothing to list). */
	modelsSaved(summary: string): string;
	/** First status line of the Save tab. */
	ready: string;
}

export const GITHUB_WORDING: Wording = {
	where: 'GitHub',
	loaded: 'Loaded the latest scene from GitHub.',
	sceneSaved: 'Saved — site rebuilding (~1–2 min).',
	modelsUpToDate: 'The model library on GitHub was already up to date. Nothing was committed.',
	modelAdded: (label) => `Added "${label}". Place it from "Add to room"; click Save models to publish it.`,
	modelsSaved: (summary) => `Saved models${summary ? ` (${summary})` : ''}. Live after the site rebuilds (~1–2 min).`,
	ready: 'Editing the copy bundled with this build. Enter a token to load or save.',
};
