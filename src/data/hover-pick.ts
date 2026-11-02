// When the public viewer may re-pick the object under the mouse. Pure TypeScript, no imports, so Node can test it.
// room-interact.ts calls it before every pick: from a pointer move, from a camera move (once per frame while the
// camera is moving) and once on release.

export interface HoverPickState {
	/** The interaction layer was disposed. */
	disposed: boolean;
	/** The pointer is over the canvas (and has not left it since). */
	inside: boolean;
	/** The last pointer was a mouse: touch and pen have no hover. */
	mouse: boolean;
	/** A button or finger is down: the camera is being dragged, so there is no hover until release. */
	dragging: boolean;
}

export function canPickHover(state: HoverPickState): boolean {
	return !state.disposed && state.inside && state.mouse && !state.dragging;
}

/**
 * Who does the pick for a pointer move. While the camera has moved in this or the previous frame the frame hook picks
 * (it sees the up-to-date camera, and it is the one place that picks while the camera moves, once per frame); otherwise
 * the pointer move picks on its own animation frame.
 */
export function pointerPickOwner(cameraMovedSinceFrame: boolean, cameraMovedLastFrame: boolean): 'frame' | 'pointer' {
	return cameraMovedSinceFrame || cameraMovedLastFrame ? 'frame' : 'pointer';
}
