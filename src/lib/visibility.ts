import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';

/**
 * Node ids that are hidden because an ancestor is collapsed.
 *
 * Collapsing hides the whole subtree (children, grandchildren, ...), so the
 * layout can treat a collapsed node as a leaf and the canvas stays readable.
 */
export function computeHidden(nodes: MindNode[], edges: Edge[]): Set<string> {
	const children = new Map<string, string[]>();
	for (const n of nodes) children.set(n.id, []);
	for (const e of edges) {
		const list = children.get(e.source);
		if (list && children.has(e.target)) list.push(e.target);
	}

	const hidden = new Set<string>();

	const walk = (id: string) => {
		for (const child of children.get(id) ?? []) {
			if (hidden.has(child)) continue; // also guards against cycles
			hidden.add(child);
			walk(child);
		}
	};

	for (const n of nodes) {
		if (n.data?.collapsed) walk(n.id);
	}

	return hidden;
}

/** How many direct children each node has. */
export function childCounts(nodes: MindNode[], edges: Edge[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const n of nodes) counts.set(n.id, 0);
	for (const e of edges) {
		if (!counts.has(e.source) || !counts.has(e.target)) continue;
		counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
	}
	return counts;
}

/** Filter out hidden nodes and any edge touching them. */
export function visibleGraph(nodes: MindNode[], edges: Edge[]) {
	const hidden = computeHidden(nodes, edges);
	return {
		hidden,
		nodes: nodes.filter((n) => !hidden.has(n.id)),
		edges: edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)),
	};
}
