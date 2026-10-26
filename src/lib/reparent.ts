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
	if (target.mode === 'detach') {
		// nothing to do when it is already a root
		if (!parentOf(edges, draggedId)) return null;
		return { edges: edges.filter((e) => e.target !== draggedId), order: 0 };
	}

	const hoveredId = target.hoveredId;
	if (!hoveredId || hoveredId === draggedId) return null;
	// a node cannot become a child/sibling of its own descendant
	if (isAncestor(edges, draggedId, hoveredId)) return null;

	// the dragged node's existing edge (if any) is replaced
	const without = edges.filter((e) => e.target !== draggedId);

	if (target.mode === 'child') {
		const siblings = childrenOf(without, hoveredId);
		return {
			edges: [...without, { id: `e_${draggedId}_${hoveredId}`, source: hoveredId, target: draggedId, type: 'mind' }],
			order: siblings.length,
		};
	}

	// sibling before/after: attach to the hovered node's parent
	const newParent = parentOf(without, hoveredId);
	if (!newParent) {
		// hovered node is a root: the dragged node becomes a root too, ordered
		// relative to it. There is no edge to add.
		return { edges: without, order: target.mode === 'sibling-before' ? -1 : 1 };
	}

	// NOTE: take the parent's children from the ORIGINAL list (which still has the
	// dragged node) so a node that was already a sibling is not dropped.
	const siblings = childrenOf(edges, newParent);
	const idx = siblings.indexOf(hoveredId);
	if (idx === -1) return null;

	// remove the dragged node, then re-insert it at the requested slot
	const withoutDragged = siblings.filter((id) => id !== draggedId);
	const anchorIdx = withoutDragged.indexOf(hoveredId);
	const insertAt =
		target.mode === 'sibling-before' ? anchorIdx : anchorIdx + 1;

	const orderedTargets = [...withoutDragged];
	orderedTargets.splice(insertAt, 0, draggedId);

	// rebuild the parent's child edges in the new order, keeping ids where possible
	const parentEdges = edges.filter((e) => e.source === newParent);
	const others = without.filter((e) => e.source !== newParent);
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
