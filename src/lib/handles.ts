import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';
import { DEFAULT_STRUCTURE, getStructure, type Direction, type StructureId } from './structures';
import { estimateHeight } from './layout';

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
 * Vertical structures use bottom→top / top→bottom.
 *
 * The fishbone is different again, and matches how ProcessOn draws it:
 *  - head→branch connectors leave the head's RIGHT edge (they run along the
 *    spine and then rise as the 60° bone into the branch box's bottom/top edge)
 *  - branch→second-level connectors leave the branch box's BOTTOM/TOP edge —
 *    the tip of its bone — so the drawer can rebuild the bone line from the
 *    handle position
 *  - deeper levels are ordinary forward connectors
 * `data.fishbone` tells MindEdge which drawing style ("bone" or "rib") to use.
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

	// facts the fishbone connectors need: the spine level, the head's id, and
	// each node's parent (to tell a branch from a rib from a deep level)
	let spineY = 0;
	let fishRootId: string | undefined;
	const parentOfId = new Map<string, string>();
	if (sid === 'fishbone') {
		const root = nodes.find((n) => n.data?.tone === 'root');
		fishRootId = root?.id;
		spineY = root ? root.position.y + estimateHeight(root) / 2 : 0;
		for (const e of edges) if (!parentOfId.has(e.target)) parentOfId.set(e.target, e.source);
	}

	const centerY = (n: MindNode) => n.position.y + estimateHeight(n) / 2;

	return edges.map((edge) => {
		const s = byId.get(edge.source);
		const t = byId.get(edge.target);
		if (!s || !t) return edge;

		let sourceHandle: string;
		let targetHandle: string;
		/** drawing style for MindEdge; only set in the fishbone structure */
		let fishbone: 'bone' | 'rib' | null = null;

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
			if (edge.source === fishRootId) {
				/**
				 * The spine + one bone. The head's right handle sits ON the spine
				 * (the layout centres the head on it), and the branch box's
				 * bottom/top handle is the bone's tip — from those two points
				 * MindEdge rebuilds the exact 60° diagonal.
				 */
				fishbone = 'bone';
				sourceHandle = HANDLE.sourceRight;
				targetHandle = centerY(t) < spineY ? HANDLE.targetBottom : HANDLE.targetTop;
			} else if (parentOfId.get(edge.source) === fishRootId) {
				/**
				 * A rib: horizontal from the bone to the box's left edge. The
				 * source handle is the branch box's bone-side edge (bottom for
				 * up-bones, top for down-bones), because the drawer walks the
				 * 60° bone back down from that point to where the rib leaves it.
				 */
				fishbone = 'rib';
				sourceHandle = centerY(s) < spineY ? HANDLE.sourceBottom : HANDLE.sourceTop;
				targetHandle = HANDLE.targetLeft;
			} else {
				// deeper levels: plain right-growing connectors
				const forward = t.position.x + NODE_W / 2 >= s.position.x + NODE_W / 2;
				sourceHandle = forward ? HANDLE.sourceRight : HANDLE.sourceLeft;
				targetHandle = forward ? HANDLE.targetLeft : HANDLE.targetRight;
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

		const prevTag =
			(edge.data as { fishbone?: 'bone' | 'rib' | null } | undefined)?.fishbone ?? null;
		if (
			edge.sourceHandle === sourceHandle &&
			edge.targetHandle === targetHandle &&
			prevTag === fishbone
		) {
			return edge; // unchanged, keep referential identity for memoisation
		}
		return { ...edge, sourceHandle, targetHandle, data: { ...edge.data, fishbone } };
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
