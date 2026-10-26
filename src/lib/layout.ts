import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';

/** Node box geometry used by the auto-layout. */
export const NODE_WIDTH = 210;
const H_GAP = 76;
const V_GAP = 22;
const LABEL_LINE = 22;
/** Height reserved for the image row: 40px thumbnails + padding. */
const IMAGE_BLOCK = 52;

/** Estimated height of a node given its text + optional images. */
export function estimateHeight(node: MindNode): number {
	const label = node.data?.label ?? '';
	// Markdown text wraps earlier than plain text; count roughly 8 chars/line
	const charsPerLine = 8;
	const explicitLines = label.split('\n').length;
	const lines = Math.max(explicitLines, Math.ceil(label.length / charsPerLine));
	const textH = lines * LABEL_LINE + 18;
	const imgH = (node.data?.images?.length ?? 0) > 0 ? IMAGE_BLOCK : 0;
	return textH + imgH + 10;
}

interface Tree {
	children: Map<string, string[]>;
	roots: string[];
}

/**
 * Build a forest from the edge list.
 *
 * Two guards matter here:
 *  1. A node may have at most ONE parent. Extra incoming edges are ignored, so a
 *     stray connection drawn from the root to an already-parented node cannot
 *     corrupt the tree.
 *  2. Edges that would close a cycle are dropped entirely. Without this the
 *     layout recursion never terminates (stack overflow -> blank screen).
 */
function buildTree(nodes: MindNode[], edges: Edge[]): Tree {
	const ids = new Set(nodes.map((n) => n.id));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const children = new Map<string, string[]>();
	const parentOf = new Map<string, string>();

	for (const n of nodes) children.set(n.id, []);

	for (const e of edges) {
		if (!ids.has(e.source) || !ids.has(e.target)) continue;
		if (e.source === e.target) continue;
		// keep only the first parent per node
		if (parentOf.has(e.target)) continue;

		// walk up from the source; if we reach the target we'd create a cycle
		let cursor: string | undefined = e.source;
		let cyclic = false;
		const seen = new Set<string>();
		while (cursor) {
			if (cursor === e.target) {
				cyclic = true;
				break;
			}
			if (seen.has(cursor)) break;
			seen.add(cursor);
			cursor = parentOf.get(cursor);
		}
		if (cyclic) continue;

		children.get(e.source)!.push(e.target);
		parentOf.set(e.target, e.source);
	}

	// A collapsed node behaves like a leaf: its subtree takes no vertical space,
	// so the rest of the map closes up around it.
	for (const [id, kids] of children) {
		if (byId.get(id)?.data?.collapsed && kids.length) children.set(id, []);
	}

	let roots = nodes.filter((n) => !parentOf.has(n.id)).map((n) => n.id);
	if (!roots.length && nodes.length) roots = [nodes[0].id];
	return { children, roots };
}

/**
 * Horizontal mind-map layout: root on the left, children fanning out to the right.
 * Positions are absolute; call with the full node set of a map.
 */
export function layoutTree(nodes: MindNode[], edges: Edge[]): MindNode[] {
	if (!nodes.length) return nodes;

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const { children, roots } = buildTree(nodes, edges);

	const heights = new Map<string, number>();
	const depth = new Map<string, number>();
	const visited = new Set<string>();

	// subtree height, depth-first. The stack set is a second safety net in case
	// buildTree ever lets a cycle through.
	const measure = (id: string, d: number, stack: Set<string>): number => {
		if (stack.has(id)) return estimateHeight(byId.get(id)!);
		if (heights.has(id)) return heights.get(id)!;
		stack.add(id);
		depth.set(id, d);
		visited.add(id);

		const self = estimateHeight(byId.get(id)!);
		const kids = children.get(id) ?? [];
		let total = 0;
		for (const k of kids) total += measure(k, d + 1, stack) + V_GAP;
		if (total > 0) total -= V_GAP;

		stack.delete(id);
		const h = Math.max(self, total);
		heights.set(id, h);
		return h;
	};

	for (const r of roots) measure(r, 0, new Set());

	// any node not reached (detached component) becomes its own root
	for (const n of nodes) {
		if (!visited.has(n.id)) {
			roots.push(n.id);
			measure(n.id, 0, new Set());
		}
	}

	const positioned = new Map<string, { x: number; y: number }>();

	const place = (id: string, top: number, stack: Set<string>): void => {
		if (stack.has(id)) return; // cycle guard — never recurse twice into one branch
		stack.add(id);

		const selfH = estimateHeight(byId.get(id)!);
		const boxH = heights.get(id) ?? selfH;
		const d = depth.get(id) ?? 0;
		const x = d * (NODE_WIDTH + H_GAP);
		const y = top + (boxH - selfH) / 2;
		positioned.set(id, { x, y });

		const kids = children.get(id) ?? [];
		let cursor = top + (boxH - (kids.reduce((s, k) => s + (heights.get(k) ?? selfH) + V_GAP, 0) - V_GAP)) / 2;
		for (const k of kids) {
			place(k, cursor, stack);
			cursor += (heights.get(k) ?? selfH) + V_GAP;
		}

		stack.delete(id);
	};

	let top = 0;
	for (const r of roots) {
		place(r, top, new Set());
		top += (heights.get(r) ?? 60) + V_GAP * 3;
	}

	return nodes.map((n) => {
		const p = positioned.get(n.id);
		return p ? { ...n, position: { x: p.x, y: p.y } } : n;
	});
}

/** Drop edges whose endpoints no longer exist. */
export function pruneEdges(nodes: MindNode[], edges: Edge[]): Edge[] {
	const ids = new Set(nodes.map((n) => n.id));
	return edges.filter((e) => ids.has(e.source) && ids.has(e.target));
}

/** True when adding source->target would create a cycle in the given edge set. */
export function wouldCreateCycle(edges: Edge[], source: string, target: string): boolean {
	if (source === target) return true;
	// walk forward from target; if we can reach source, the new edge closes a loop
	const out = new Map<string, string[]>();
	for (const e of edges) {
		if (!out.has(e.source)) out.set(e.source, []);
		out.get(e.source)!.push(e.target);
	}
	const stack = [target];
	const seen = new Set<string>();
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur === source) return true;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const next of out.get(cur) ?? []) stack.push(next);
	}
	return false;
}
