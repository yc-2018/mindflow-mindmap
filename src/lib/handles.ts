import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';
import { DEFAULT_STRUCTURE, getStructure, type Direction, type StructureId } from './structures';

/**
 * Handle ids on a mind node. Each side carries a source and a target handle so a
 * connector can always leave/enter on the side that faces the other node.
 */
export const HANDLE = {
	sourceRight: 's-right',
	sourceLeft: 's-left',
	sourceBottom: 's-bottom',
	sourceTop: 's-top',
	targetLeft: 't-left',
	targetRight: 't-right',
	targetTop: 't-top',
	targetBottom: 't-bottom',
} as const;

/** Approximate node width, used to compare node centres. */
const NODE_W = 210;

/** Handles to use for a child that grows in the given direction. */
export function handlesForDirection(dir: Direction): { sourceHandle: string; targetHandle: string } {
	switch (dir) {
		case 'left':
			return { sourceHandle: HANDLE.sourceLeft, targetHandle: HANDLE.targetRight };
		case 'down':
			return { sourceHandle: HANDLE.sourceBottom, targetHandle: HANDLE.targetTop };
		case 'up':
			return { sourceHandle: HANDLE.sourceTop, targetHandle: HANDLE.targetBottom };
		case 'right':
		default:
			return { sourceHandle: HANDLE.sourceRight, targetHandle: HANDLE.targetLeft };
	}
}

/**
 * Assign each edge the handles that make the shortest, cleanest connector.
 *
 * Horizontal structures compare node centres and pick the side that faces the
 * other node. This is done from GEOMETRY, never from a stored `side` flag: a node
 * dragged to the other side of the root kept its old flag, so connectors left the
 * wrong edge and looped around.
 *
 * Vertical structures use bottom→top / top→bottom; the fishbone enters ribs from
 * their top/bottom edge because they hang off a horizontal spine.
 */
export function withAdaptiveHandles(
	nodes: MindNode[],
	edges: Edge[],
	structure: StructureId = DEFAULT_STRUCTURE,
): Edge[] {
	if (!edges.length) return edges;

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const sid = getStructure(structure);
	const vertical = sid === 'down' || sid === 'up';

	return edges.map((edge) => {
		const s = byId.get(edge.source);
		const t = byId.get(edge.target);
		if (!s || !t) return edge;

		let sourceHandle: string;
		let targetHandle: string;

		if (vertical) {
			// grow downward: parent bottom -> child top; upward: parent top -> child bottom
			const childBelow = t.position.y >= s.position.y;
			if (sid === 'down') {
				sourceHandle = HANDLE.sourceBottom;
				targetHandle = childBelow ? HANDLE.targetTop : HANDLE.targetBottom;
			} else {
				sourceHandle = HANDLE.sourceTop;
				targetHandle = childBelow ? HANDLE.targetBottom : HANDLE.targetTop;
			}
		} else if (sid === 'fishbone') {
			/**
			 * Fishbone connectors.
			 *
			 * A rib hangs off the spine, so the head→rib line is horizontal and the
			 * rib→child line is vertical. Which handle a rib's children use depends
			 * on whether they sit above or below it.
			 *
			 * The test is deliberately NOT a ratio: a rib's children are directly
			 * above/below it with only one column of horizontal offset, so the
			 * vertical component is small in absolute terms but still the dominant
			 * direction. Comparing |dy| against |dx| is enough — a ratio threshold
			 * mis-classified them as horizontal, which made React Flow draw arcs
			 * that crossed the neighbouring ribs (28 crossings on a real map).
			 */
			const sc = { x: s.position.x + NODE_W / 2, y: s.position.y };
			const tc = { x: t.position.x + NODE_W / 2, y: t.position.y };
			const dx = Math.abs(tc.x - sc.x);
			const dy = tc.y - sc.y;

			if (Math.abs(dy) >= dx) {
				// the child is above/below the parent: enter from its facing edge
				sourceHandle = HANDLE.sourceRight;
				targetHandle = dy < 0 ? HANDLE.targetBottom : HANDLE.targetTop;
			} else {
				// side-by-side: plain horizontal connector
				sourceHandle = tc.x >= sc.x ? HANDLE.sourceRight : HANDLE.sourceLeft;
				targetHandle = tc.x >= sc.x ? HANDLE.targetLeft : HANDLE.targetRight;
			}
		} else {
			/**
			 * All horizontal structures (balanced / right / left / both) resolve the
			 * same way: whichever side of the parent the child actually sits on.
			 *
			 * Using geometry instead of `data.side` fixes the two-sided layout: after
			 * a node was dragged across the root, its stored side was stale and the
			 * connector left from the far edge, wrapping around the node.
			 */
			const forward = t.position.x + NODE_W / 2 >= s.position.x + NODE_W / 2;
			sourceHandle = forward ? HANDLE.sourceRight : HANDLE.sourceLeft;
			targetHandle = forward ? HANDLE.targetLeft : HANDLE.targetRight;
		}

		if (edge.sourceHandle === sourceHandle && edge.targetHandle === targetHandle) {
			return edge; // unchanged, keep referential identity for memoisation
		}
		return { ...edge, sourceHandle, targetHandle };
	});
}

/** Handles for a brand-new connection between the two nodes. */
export function handlesFor(
	nodes: MindNode[],
	source: string,
	target: string,
	structure: StructureId = DEFAULT_STRUCTURE,
) {
	const s = nodes.find((n) => n.id === source);
	const t = nodes.find((n) => n.id === target);
	if (!s || !t) return handlesForDirection('right');

	const sid = getStructure(structure);
	if (sid === 'down' || sid === 'up') {
		return handlesForDirection(sid === 'down' ? 'down' : 'up');
	}
	if (sid === 'fishbone') {
		return handlesForDirection('right');
	}

	// every horizontal structure: use the real relative position
	const forward = t.position.x + NODE_W / 2 >= s.position.x + NODE_W / 2;
	return forward
		? { sourceHandle: HANDLE.sourceRight, targetHandle: HANDLE.targetLeft }
		: { sourceHandle: HANDLE.sourceLeft, targetHandle: HANDLE.targetRight };
}
