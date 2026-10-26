import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';

/**
 * Handle ids on a mind node. Both sides carry a source and a target handle so a
 * connector can always leave/enter on the side that faces the other node.
 */
export const HANDLE = {
	sourceRight: 's-right',
	sourceLeft: 's-left',
	targetLeft: 't-left',
	targetRight: 't-right',
} as const;

/** Approximate node width, used to compare node centres. */
const NODE_W = 210;

/**
 * Assign each edge the handles that make the shortest, cleanest connector.
 *
 * React Flow draws the connector from the *chosen handle* of the source to the
 * chosen handle of the target. With a single fixed right→left pair, a node
 * dragged to the LEFT of its parent forces the line to leave rightwards, wrap
 * around, and come back — the big loop users see.
 *
 * By flipping to source-left/target-right whenever the target sits behind the
 * source, the connector simply travels in the other direction.
 */
export function withAdaptiveHandles(nodes: MindNode[], edges: Edge[]): Edge[] {
	if (!edges.length) return edges;

	const byId = new Map(nodes.map((n) => [n.id, n]));

	return edges.map((edge) => {
		const s = byId.get(edge.source);
		const t = byId.get(edge.target);
		if (!s || !t) return edge;

		// compare node centres so tall/narrow nodes still resolve correctly
		const sCenter = s.position.x + NODE_W / 2;
		const tCenter = t.position.x + NODE_W / 2;
		const forward = tCenter >= sCenter;

		const sourceHandle = forward ? HANDLE.sourceRight : HANDLE.sourceLeft;
		const targetHandle = forward ? HANDLE.targetLeft : HANDLE.targetRight;

		if (edge.sourceHandle === sourceHandle && edge.targetHandle === targetHandle) {
			return edge; // unchanged, keep referential identity for memoisation
		}
		return { ...edge, sourceHandle, targetHandle };
	});
}

/** Handles for a brand-new connection between the two nodes. */
export function handlesFor(nodes: MindNode[], source: string, target: string) {
	const s = nodes.find((n) => n.id === source);
	const t = nodes.find((n) => n.id === target);
	if (!s || !t) {
		return { sourceHandle: HANDLE.sourceRight, targetHandle: HANDLE.targetLeft };
	}
	const forward = t.position.x + NODE_W / 2 >= s.position.x + NODE_W / 2;
	return {
		sourceHandle: forward ? HANDLE.sourceRight : HANDLE.sourceLeft,
		targetHandle: forward ? HANDLE.targetLeft : HANDLE.targetRight,
	};
}
