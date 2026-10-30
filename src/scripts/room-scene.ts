import { createRoomCore } from './room-core';
import type { RoomConfig } from './room-core';

export type { RoomConfig } from './room-core';

export interface RoomSceneHandle {
	/** Swap to another member's room in place: tweens colours, eases the camera home, swaps the furniture. */
	setRoom(config: RoomConfig): void;
	/** Release every GPU/DOM resource. Safe to call more than once. */
	dispose(): void;
}

/** Shown instead of the canvas when WebGL cannot start. */
function createFallback(canvas: HTMLCanvasElement, config: RoomConfig): RoomSceneHandle {
	const message = (c: RoomConfig) =>
		`${c.name}'s room needs WebGL to be shown, and it isn't available in this browser.`;
	const note = document.createElement('p');
	note.setAttribute('role', 'status');
	note.className =
		'absolute inset-0 m-auto h-fit max-w-xs px-6 text-center text-stone-600 [text-wrap:balance]';
	note.textContent = message(config);
	canvas.hidden = true;
	canvas.parentElement?.append(note);
	return {
		setRoom(next) {
			note.textContent = message(next);
		},
		dispose() {
			note.remove();
			canvas.hidden = false;
		},
	};
}

export function createRoomScene(canvas: HTMLCanvasElement, initial: RoomConfig): RoomSceneHandle {
	const core = createRoomCore(canvas, initial);
	if (!core) return createFallback(canvas, initial);
	core.objects.setObjects(initial.objects ?? []);

	return {
		setRoom(config) {
			core.objects.setObjects(config.objects ?? []);
			core.setRoom(config);
		},
		dispose() {
			core.dispose();
		},
	};
}
