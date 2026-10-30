// World-space texture coordinates for the wall boxes. Pure TypeScript with only erasable syntax and no DOM/three/Astro
// imports, so Node can import it directly (`node --test`). room-core.ts gives every wall piece its own translated
// BoxGeometry and overwrites its `uv` attribute with boxUvs(), so one texture field runs unbroken across the jambs,
// the pieces above and below the window, the caps and the end faces.
//
// Each face is projected along its dominant normal axis. The projection is right-handed as seen from outside (u to
// the right, v up, like BoxGeometry's own faces), never mirrored: three derives a normal map's tangent frame from the
// UV derivatives, and a mirrored face would flip its bump direction.

/** The UV of a point on a face with outward `normal`; `tile` is the world length of one texture repeat. */
export function worldUv(
	normal: readonly [number, number, number],
	position: readonly [number, number, number],
	tile: number,
): [number, number] {
	const [nx, ny, nz] = normal;
	const [x, y, z] = position;
	const ax = Math.abs(nx);
	const ay = Math.abs(ny);
	const az = Math.abs(nz);
	if (ax >= ay && ax >= az) return [(nx > 0 ? -z : z) / tile, y / tile];
	if (az >= ay) return [(nz > 0 ? x : -x) / tile, y / tile];
	return [x / tile, (ny > 0 ? -z : z) / tile];
}

/** The `uv` array (2 numbers per vertex) for vertices given as flat `positions` and `normals` arrays (3 numbers each). */
export function boxUvs(positions: ArrayLike<number>, normals: ArrayLike<number>, tile: number): number[] {
	if (!(tile > 0)) throw new RangeError('tile must be positive');
	if (positions.length !== normals.length || positions.length % 3 !== 0) {
		throw new RangeError('positions and normals must be the same length, a multiple of 3');
	}
	const uvs: number[] = [];
	for (let i = 0; i < positions.length; i += 3) {
		uvs.push(...worldUv([normals[i], normals[i + 1], normals[i + 2]], [positions[i], positions[i + 1], positions[i + 2]], tile));
	}
	return uvs;
}
