// Rows of the "Objects in this room" list: names, numbering and availability.
// Pure TypeScript with only erasable syntax and no imports (no DOM/three/Astro), so Node can import it
// directly (`node --test`). The DOM wiring lives in main.ts.

/** What the editor reports per object (`Editor.getObjects()`). */
export interface ListedObject {
	id: string;
	/** A primitive name or `model:<id>`. */
	type: string;
	/** False when the object's model is not in the catalog: it is kept in the file but has no 3D view. */
	shown: boolean;
	/** True when the object has a paragraph (a note visitors can open); the row gets a small marker. */
	hasNote?: boolean;
}

export interface ObjectRow {
	id: string;
	/** What the row says: "Chair", "Chair 2" (numbered per label when several share it) or "model:sofa — not available". */
	label: string;
	/** False for objects that are not shown: the row is greyed out, cannot be selected and has no delete button. */
	available: boolean;
	/** Accessible name of the delete button ("Delete Chair 2"); null for unavailable rows. */
	deleteLabel: string | null;
	/** The row shows a "note" marker. Never set on unavailable rows. */
	hasNote: boolean;
}

export const NOT_AVAILABLE = ' — not available';

/**
 * One row per object, in the given order. `labelOf(type)` returns the catalog label (undefined when unknown;
 * the raw type is used then). Available objects whose label is shared by several of them are numbered from 1 in
 * list order ("Chair 1", "Chair 2"); a label that occurs once stays plain. Unavailable objects are never
 * numbered and do not count towards the numbering.
 */
export function buildObjectRows(
	objects: readonly ListedObject[],
	labelOf: (type: string) => string | undefined,
): ObjectRow[] {
	const nameOf = (object: ListedObject) => labelOf(object.type) ?? object.type;
	const totals = new Map<string, number>();
	for (const object of objects) {
		if (object.shown) totals.set(nameOf(object), (totals.get(nameOf(object)) ?? 0) + 1);
	}
	const seen = new Map<string, number>();
	return objects.map((object): ObjectRow => {
		const name = nameOf(object);
		if (!object.shown) return { id: object.id, label: `${object.type}${NOT_AVAILABLE}`, available: false, deleteLabel: null, hasNote: false };
		const n = (seen.get(name) ?? 0) + 1;
		seen.set(name, n);
		const label = (totals.get(name) ?? 0) > 1 ? `${name} ${n}` : name;
		return { id: object.id, label, available: true, deleteLabel: `Delete ${label}`, hasNote: object.hasNote === true };
	});
}

/** Changes exactly when the list has to be rebuilt (ids, order, labels, availability or the note marker); not on colour or transform edits. */
export function objectRowsSignature(rows: readonly ObjectRow[]): string {
	return rows.map((row) => `${row.id}\u0000${row.label}\u0000${row.available ? 1 : 0}\u0000${row.hasNote ? 1 : 0}`).join('\n');
}
