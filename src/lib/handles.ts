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
 * For horizontal structures we compare node centres and flip sides when the
 * target sits behind the source (which is what used to cause the big loop).
 * For vertical structures the pair is bottom→top / top→bottom.
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
			// The spine runs horizontally, so bones leave/enter horizontally too.
			// A rib above the spine enters on its bottom edge, below on its top edge.
			const childAbove = t.position.y < s.position.y;
			sourceHandle = HANDLE.sourceRight;
			targetHandle = childAbove ? HANDLE.targetBottom : HANDLE.targetTop;
		} else if (sid === 'both') {
			// side comes from the node itself; two-sided layouts mirror per child
			const onLeft = (t.data?.side ?? 'right') === 'left';
			sourceHandle = onLeft ? HANDLE.sourceLeft : HANDLE.sourceRight;
			targetHandle = onLeft ? HANDLE.targetRight : HANDLE.targetLeft;
		} else if (sid === 'left') {
			sourceHandle = HANDLE.sourceLeft;
			targetHandle = HANDLE.targetRight;
		} else {
			// right / balanced: compare centres so a dragged-behind node flips
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
	if (sid === 'left') return handlesForDirection('left');
	if (sid === 'both' || sid === 'fishbone') {
		return handlesForDirection((t.data?.side ?? 'right') === 'left' ? 'left' : 'right');
	}

	const forward = t.position.x + NODE_W / 2 >= s.position.x + NODE_W / 2;
	return forward
		? { sourceHandle: HANDLE.sourceRight, targetHandle: HANDLE.targetLeft }
		: { sourceHandle: HANDLE.sourceLeft, targetHandle: HANDLE.targetRight };
}
