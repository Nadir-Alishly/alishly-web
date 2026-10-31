// The "Scene settings" panel of /admin: one <details> group per kind of setting, each control a slider paired with a
// number input (colour inputs for colours) and a "Reset to defaults" button per group. Built from the schema below, so the
// markup is not hand-written; the labels, steps and grouping are admin-only and live here, while the defaults and ranges
// come from src/data/scene-settings.ts. Everything user-visible goes through textContent.
import { DEFAULT_SETTINGS, SETTING_RANGES, cloneSettings } from '../../data/scene-settings';
import type { SceneSettings, SettingsGroup } from '../../data/scene-settings';

interface NumberControl {
	kind: 'number';
	key: string;
	label: string;
	step: number;
	unit?: string;
	hint?: string;
	/** The default is a derived, unrounded value (the sun and key angles): a free slider keeps it exact instead of snapping the thumb. */
	free?: boolean;
}
interface ColorControl {
	kind: 'color';
	key: string;
	label: string;
}
type Control = NumberControl | ColorControl;

interface GroupDef {
	group: SettingsGroup;
	title: string;
	hint?: string;
	controls: Control[];
}

const SCHEMA: GroupDef[] = [
	{
		group: 'floor',
		title: 'Floor texture',
		controls: [
			{ kind: 'number', key: 'tile', label: 'Tile size', step: 0.1, unit: 'units' },
			{ kind: 'number', key: 'rotation', label: 'Rotation', step: 1, unit: '°' },
			{ kind: 'number', key: 'offsetX', label: 'Offset X', step: 0.01 },
			{ kind: 'number', key: 'offsetY', label: 'Offset Y', step: 0.01 },
			{ kind: 'number', key: 'roughness', label: 'Roughness', step: 0.05 },
			{ kind: 'number', key: 'envIntensity', label: 'Reflection', step: 0.05 },
		],
	},
	{
		group: 'wall',
		title: 'Wall texture',
		hint: 'Bump strength has no effect on touch screens, which skip the bump map.',
		controls: [
			{ kind: 'number', key: 'tile', label: 'Tile size', step: 0.5, unit: 'units' },
			{ kind: 'number', key: 'rotation', label: 'Rotation', step: 1, unit: '°' },
			{ kind: 'number', key: 'offsetX', label: 'Offset X', step: 0.01 },
			{ kind: 'number', key: 'offsetY', label: 'Offset Y', step: 0.01 },
			{ kind: 'number', key: 'normalScale', label: 'Bump strength', step: 0.1 },
		],
	},
	{
		group: 'sun',
		title: 'Sun',
		hint: 'The angles are limited to where sunlight can only come in through the window.',
		controls: [
			{ kind: 'color', key: 'color', label: 'Colour' },
			{ kind: 'number', key: 'intensity', label: 'Intensity', step: 0.1 },
			{ kind: 'number', key: 'azimuth', label: 'Azimuth (towards back wall)', step: 0.5, unit: '°', free: true },
			{ kind: 'number', key: 'elevation', label: 'Elevation', step: 0.5, unit: '°', free: true },
			{ kind: 'number', key: 'shadowRadius', label: 'Shadow softness', step: 0.1 },
		],
	},
	{
		group: 'glow',
		title: 'Window glow',
		hint: 'A floor pool opacity above about 0.14 clips the sun patch on the oak (the pool is added on top of it).',
		controls: [
			{ kind: 'color', key: 'color', label: 'Colour' },
			{ kind: 'number', key: 'haloOpacity', label: 'Halo opacity', step: 0.01 },
			{ kind: 'number', key: 'haloSpread', label: 'Halo spread', step: 0.05 },
			{ kind: 'number', key: 'poolOpacity', label: 'Floor pool opacity', step: 0.01 },
			{ kind: 'number', key: 'poolSpread', label: 'Floor pool spread', step: 0.05 },
		],
	},
	{
		group: 'key',
		title: 'Key light',
		controls: [
			{ kind: 'color', key: 'color', label: 'Colour' },
			{ kind: 'number', key: 'intensity', label: 'Intensity', step: 0.05 },
			{ kind: 'number', key: 'azimuth', label: 'Azimuth', step: 1, unit: '°', free: true },
			{ kind: 'number', key: 'elevation', label: 'Elevation', step: 1, unit: '°', free: true },
			{ kind: 'number', key: 'shadowRadius', label: 'Shadow softness', step: 0.1 },
		],
	},
	{
		group: 'fill',
		title: 'Fill & environment',
		controls: [
			{ kind: 'color', key: 'sky', label: 'Sky colour' },
			{ kind: 'color', key: 'ground', label: 'Ground colour' },
			{ kind: 'number', key: 'intensity', label: 'Fill intensity', step: 0.05 },
			{ kind: 'number', key: 'envIntensity', label: 'Environment intensity', step: 0.01 },
			{
				kind: 'number',
				key: 'exposure',
				label: 'Exposure',
				step: 0.05,
				hint: "Exposure doesn't dim the window glow: the panes, halo and floor pool ignore it.",
			},
		],
	},
	{
		group: 'shadows',
		title: 'Advanced shadows',
		hint: 'Shadow bias fixes speckles or floating shadows. Leave these alone unless you see an artefact.',
		controls: [
			{ kind: 'number', key: 'bias', label: 'Bias', step: 0.0001 },
			{ kind: 'number', key: 'normalBias', label: 'Normal bias', step: 0.005 },
		],
	},
];

const fieldClass =
	'rounded-lg border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 outline-offset-2 focus-visible:outline-2 focus-visible:outline-stone-900';
const resetClass =
	'rounded-full px-3 py-1.5 text-sm font-medium text-stone-700 ring-1 ring-stone-300 outline-offset-2 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-stone-900';

type Flat = Record<string, Record<string, number | string>>;

export interface SettingsPanel {
	/** Show these settings in every control (after "Load latest"). Does not call onChange. */
	set(settings: SceneSettings): void;
}

export interface SettingsPanelOptions {
	initial: SceneSettings;
	/** Called with a complete copy after every change the user makes (also by a group reset). */
	onChange(next: SceneSettings): void;
}

const show = (value: number) => String(Math.round(value * 1e4) / 1e4);

export function mountSettingsPanel(container: HTMLElement, options: SettingsPanelOptions): SettingsPanel {
	let state = cloneSettings(options.initial);
	// Refreshes every control of one group from `state`.
	const refreshers = new Map<SettingsGroup, (() => void)[]>();
	const flat = () => state as unknown as Flat;
	const defaults = DEFAULT_SETTINGS as unknown as Flat;

	const change = (group: SettingsGroup, key: string, value: number | string) => {
		flat()[group][key] = value;
		options.onChange(cloneSettings(state));
	};

	for (const def of SCHEMA) {
		const { group } = def;
		const list: (() => void)[] = [];
		refreshers.set(group, list);

		const details = document.createElement('details');
		details.className = 'rounded-lg ring-1 ring-stone-200 open:bg-stone-50';
		const summary = document.createElement('summary');
		summary.className = 'cursor-pointer px-3 py-2 text-sm font-medium text-stone-800';
		summary.textContent = def.title;
		details.append(summary);

		const body = document.createElement('div');
		body.className = 'space-y-3 px-3 pb-3';
		details.append(body);

		if (def.hint) {
			const hint = document.createElement('p');
			hint.className = 'text-xs text-stone-500';
			hint.textContent = def.hint;
			body.append(hint);
		}

		for (const control of def.controls) {
			const id = `setting-${group}-${control.key}`;
			const row = document.createElement('div');
			const label = document.createElement('label');
			label.htmlFor = id;
			label.className = 'block text-xs font-medium text-stone-500';
			label.textContent = control.unit && control.kind === 'number' ? `${control.label} (${control.unit})` : control.label;
			row.append(label);

			if (control.kind === 'color') {
				const input = document.createElement('input');
				input.type = 'color';
				input.id = id;
				input.className = 'h-9 w-14 cursor-pointer rounded-lg border border-stone-300 bg-white p-1';
				input.addEventListener('input', () => change(group, control.key, input.value.toLowerCase()));
				list.push(() => (input.value = String(flat()[group][control.key])));
				input.value = String(flat()[group][control.key]);
				row.append(input);
			} else {
				const { min, max } = SETTING_RANGES[group][control.key];
				const line = document.createElement('div');
				line.className = 'mt-1 flex items-center gap-2';
				const range = document.createElement('input');
				range.type = 'range';
				range.min = String(min);
				range.max = String(max);
				range.step = control.free ? 'any' : String(control.step);
				range.className = 'min-w-0 flex-1 accent-stone-900';
				range.setAttribute('aria-label', control.label);
				const number = document.createElement('input');
				number.type = 'number';
				number.id = id;
				number.min = String(min);
				number.max = String(max);
				number.step = String(control.step);
				number.className = `${fieldClass} w-24`;
				const sync = () => {
					const value = Number(flat()[group][control.key]);
					range.value = String(value);
					number.value = show(value);
				};
				range.addEventListener('input', () => {
					const value = Number(range.value);
					number.value = show(value);
					change(group, control.key, value);
				});
				number.addEventListener('input', () => {
					// While typing: apply what already is a valid number in range; the field itself is left alone.
					const value = Number(number.value);
					if (number.value.trim() === '' || !Number.isFinite(value)) return;
					const clamped = Math.min(max, Math.max(min, value));
					range.value = String(clamped);
					change(group, control.key, clamped);
				});
				number.addEventListener('change', sync); // show what was kept (blank or out of range is put right)
				list.push(sync);
				sync();
				line.append(range, number);
				row.append(line);
				if (control.hint) {
					const hint = document.createElement('p');
					hint.className = 'mt-1 text-xs text-stone-500';
					hint.textContent = control.hint;
					row.append(hint);
				}
			}
			body.append(row);
		}

		const reset = document.createElement('button');
		reset.type = 'button';
		reset.className = resetClass;
		reset.textContent = 'Reset to defaults';
		reset.addEventListener('click', () => {
			flat()[group] = { ...defaults[group] };
			for (const refresh of list) refresh();
			options.onChange(cloneSettings(state));
		});
		body.append(reset);

		container.append(details);
	}

	return {
		set(next) {
			state = cloneSettings(next);
			for (const list of refreshers.values()) for (const refresh of list) refresh();
		},
	};
}
