// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import localSave from './dev/local-save-plugin.mjs';

// https://astro.build/config
export default defineConfig({
	fonts: [
		{
			provider: fontProviders.google(),
			name: 'Montserrat',
			cssVariable: '--font-montserrat',
			weights: [400, 500, 600],
			styles: ['normal'],
			subsets: ['latin'],
			fallbacks: ['sans-serif'],
		},
		{
			provider: fontProviders.google(),
			name: 'Libre Baskerville',
			cssVariable: '--font-libre-baskerville',
			weights: [400, 500, 600, 700],
			styles: ['normal'],
			subsets: ['latin'],
			fallbacks: ['serif'],
		},
	],
	vite: {
		// localSave: dev-only (apply: 'serve'), lets /admin save to disk; inert in `astro build`.
		plugins: [tailwindcss(), localSave()],
	},
});
