import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';
import { childrenOf, isAncestor, parentOf } from './layout';

/**
 * Where a dragged node should land.
 *
 * The drop target is decided by comparing the dragged node's centre against the
 * hovered node's box: the middle band means "become a child", the upper/lower
 * bands mean "become a sibling before/after it".
 */
export type DropMode = 'child' | 'sibling-before' | 'sibling-after' | 'detach';

export interface DropTarget {
	mode: DropMode;
	/** Node under the cursor (absent when dropped on empty canvas). */
	hoveredId?: string;
}

/** Vertical band thresholds, as a fraction of the hovered node's extent. */
const BEFORE_BAND = 0.28;
const AFTER_BAND = 0.72;

/**
 * Resolve what a drop means from the pointer position relative to the node box.
 *
 * `rel` is the pointer offset inside the hovered node, normalised to 0..1 along
 * the sibling axis (y for horizontal structures, x for vertical ones). The
 * middle band means "become a child"; the outer bands mean "insert before/after".
 */
export function resolveDropMode(rel: number): DropMode {
	if (rel < BEFORE_BAND) return 'sibling-before';
	if (rel > AFTER_BAND) return 'sibling-after';
	return 'child';
}

/**
 * Extra distance (in flow units) around a node that still counts as "aiming at
 * it". Makes the drop target forgiving without letting a stray drag detach.
 */
export const DROP_MARGIN = 28;

/**
 * How far outside the map's overall bounding box the pointer must be before a
 * drop means "detach".
 *
 * Detaching must be deliberate. Mind maps have large gaps between nodes, so a
 * "distance to the nearest node" rule fires far too easily — that is exactly why
 * a small nudge used to break the tree. Instead we require the pointer to leave
 * the whole map area (plus this margin), which reads as "drag to the edge".
 */
export const DETACH_EDGE_MARGIN = 90;

/** Does the pointer sit inside the node's box, padded by `margin`? */
export function insideBox(
	pointer: { x: number; y: number },
	box: { x: number; y: number; w: number; h: number },
	margin = DROP_MARGIN,
): boolean {
	return (
		pointer.x >= box.x - margin &&
		pointer.x <= box.x + box.w + margin &&
		pointer.y >= box.y - margin &&
		pointer.y <= box.y + box.h + margin
	);
}

/** Squared distance from the pointer to the nearest point of a box. */
export function distanceToBox(
	pointer: { x: number; y: number },
	box: { x: number; y: number; w: number; h: number },
): number {
	const dx = Math.max(box.x - pointer.x, 0, pointer.x - (box.x + box.w));
	const dy = Math.max(box.y - pointer.y, 0, pointer.y - (box.y + box.h));
	return Math.hypot(dx, dy);
}

/**
 * Decide whether a drop at `pointer` should detach the dragged node.
 *
 * Only true when the pointer has left the map's overall bounding box by at least
 * DETACH_EDGE_MARGIN — i.e. the user deliberately dragged out to the edge.
 * A casual nudge inside the map never detaches.
 */
export function shouldDetach(
	pointer: { x: number; y: number },
	boxes: { x: number; y: number; w: number; h: number }[],
): boolean {
	if (!boxes.length) return false;
	const minX = Math.min(...boxes.map((b) => b.x));
	const minY = Math.min(...boxes.map((b) => b.y));
	const maxX = Math.max(...boxes.map((b) => b.x + b.w));
	const maxY = Math.max(...boxes.map((b) => b.y + b.h));

	const m = DETACH_EDGE_MARGIN;
	return (
		pointer.x < minX - m ||
		pointer.x > maxX + m ||
		pointer.y < minY - m ||
		pointer.y > maxY + m
	);
}

/**
 * Re-parent / re-order a node inside the tree.
 *
 * Returns the new edge list, or `null` when the move is not allowed (dropping a
 * node onto itself, onto its own descendant, or making no change).
 *
 * Rules:
 *  - 'child'          : node becomes the last child of the hovered node
 *  - 'sibling-before' : node is inserted before the hovered node
 *  - 'sibling-after'  : node is inserted after the hovered node
 *  - 'detach'         : the node loses its parent and becomes a root
 *
 * `order` on the node data records the manual sibling position so the layout can
 * honour it.
 */
export function reparentEdges(
	edges: Edge[],
	draggedId: string,
	target: DropTarget,
): { edges: Edge[]; order: number } | null {
	return reparentMany(edges, [draggedId], target);
}

/**
 * Same as `reparentEdges`, but moves SEVERAL nodes at once.
 *
 * This is what a multi-selection drag needs: dragging three selected nodes onto
 * a target must attach all three, not just the first one that happens to be the
 * drag anchor.
 *
 * Guard rules:
 *  - ids that are descendants of another id in the same batch are skipped (moving
 *    a parent already brings its subtree along)
 *  - ids that are ancestors of the drop target are skipped (would create a cycle)
 */
export function reparentMany(
	edges: Edge[],
	draggedIds: string[],
	target: DropTarget,
): { edges: Edge[]; order: number } | null {
	const ids = Array.from(new Set(draggedIds.filter(Boolean)));
	if (!ids.length) return null;

	// drop the ones that ride along with another moved ancestor
	const moving = ids.filter(
		(id) => !ids.some((other) => other !== id && isAncestor(edges, other, id)),
	);

	// never allow moving a node onto its own descendant / itself
	const hoveredId = target.hoveredId;
	if (target.mode !== 'detach' && hoveredId) {
		if (moving.includes(hoveredId)) return null;
		if (moving.some((id) => isAncestor(edges, id, hoveredId))) return null;
	}

	if (target.mode === 'detach') {
		// keep only nodes that actually have a parent
		const withParent = moving.filter((id) => Boolean(parentOf(edges, id)));
		if (!withParent.length) return null;
		return {
			edges: edges.filter((e) => !withParent.includes(e.target)),
			order: 0,
		};
	}

	if (!hoveredId) return null;

	if (target.mode === 'child') {
		// append them all as the target's children, in their original order
		const without = edges.filter((e) => !moving.includes(e.target));
		const existing = childrenOf(without, hoveredId);
		const added = moving.map((id) => ({
			id: `e_${id}_${hoveredId}`,
			source: hoveredId,
			target: id,
			type: 'mind' as const,
		}));
		return { edges: [...without, ...added], order: existing.length };
	}

	// sibling before/after: insert the whole batch next to the hovered node
	const newParent = parentOf(edges, hoveredId);
	if (!newParent) {
		// hovered node is a root: the batch becomes roots too
		const without = edges.filter((e) => !moving.includes(e.target));
		return { edges: without, order: target.mode === 'sibling-before' ? -1 : 1 };
	}

	// take the parent's children from the ORIGINAL list (which still has the
	// dragged nodes) so nodes that were already siblings are not dropped
	const siblings = childrenOf(edges, newParent);
	const anchorIdx = siblings.filter((id) => !moving.includes(id)).indexOf(hoveredId);
	if (anchorIdx === -1) return null;

	const withoutDragged = siblings.filter((id) => !moving.includes(id));
	const insertAt = target.mode === 'sibling-before' ? anchorIdx : anchorIdx + 1;

	const orderedTargets = [...withoutDragged];
	orderedTargets.splice(insertAt, 0, ...moving);

	// rebuild the parent's child edges in the new order, keeping ids where possible
	const parentEdges = edges.filter((e) => e.source === newParent);
	const others = edges.filter((e) => e.source !== newParent && !moving.includes(e.target));
	const rebuilt = orderedTargets.map((t) => {
		const existing = parentEdges.find((e) => e.target === t);
		return existing ?? { id: `e_${t}_${newParent}`, source: newParent, target: t, type: 'mind' };
	});

	return { edges: [...others, ...rebuilt], order: insertAt };
}

/** Attach order numbers to nodes based on their position among siblings. */
export function applySiblingOrder(nodes: MindNode[], edges: Edge[]): MindNode[] {
	const explicit = new Map<string, number>();
	const counters = new Map<string, number>();
	for (const e of edges) {
		const n = counters.get(e.source) ?? 0;
		explicit.set(e.target, n);
		counters.set(e.source, n + 1);
	}
	return nodes.map((n) => {
		const o = explicit.get(n.id);
		return o === n.data.order ? n : { ...n, data: { ...n.data, order: o ?? 0 } };
	});
}

/** True when the two edge lists describe the same parent relationships. */
export function sameTopology(a: Edge[], b: Edge[]): boolean {
	if (a.length !== b.length) return false;
	const key = (e: Edge) => `${e.source}>${e.target}`;
	const setA = new Set(a.map(key));
	return b.every((e) => setA.has(key(e)));
}
