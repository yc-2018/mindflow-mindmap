import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';
import { DEFAULT_STRUCTURE, getStructure, type Direction, type StructureId } from './structures';

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
	parentOf: Map<string, string>;
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
	return { children, roots, parentOf };
}

/** Per-structure geometry constants. */
interface Geometry {
	/** Step along the "depth" axis (the direction children grow). */
	depthStep: number;
	/** Step along the "sibling" axis. */
	siblingStep: number;
	/** Extent of a node along the sibling axis (used to pack siblings). */
	siblingExtent: (n: MindNode) => number;
}

const GEO: Record<Direction, Geometry> = {
	right: {
		depthStep: NODE_WIDTH + H_GAP,
		siblingStep: V_GAP,
		siblingExtent: (n) => estimateHeight(n),
	},
	left: {
		depthStep: NODE_WIDTH + H_GAP,
		siblingStep: V_GAP,
		siblingExtent: (n) => estimateHeight(n),
	},
	down: {
		depthStep: 96,
		siblingStep: 28,
		siblingExtent: () => NODE_WIDTH,
	},
	up: {
		depthStep: 96,
		siblingStep: 28,
		siblingExtent: () => NODE_WIDTH,
	},
};

/**
 * Generic tidy-tree layout, parameterised by growth direction.
 *
 * The algorithm is the classic two-pass "measure then place": first compute the
 * total extent each subtree needs along the sibling axis, then walk down again
 * centring each parent against its children.
 */
function layoutDirected(
	nodes: MindNode[],
	tree: Tree,
	dir: Direction,
	origin: { x: number; y: number },
	rootsOverride?: string[],
): Map<string, { x: number; y: number }> {
	const { children } = tree;
	const geo = GEO[dir];
	const byId = new Map(nodes.map((n) => [n.id, n]));

	// which axis does depth/sibling map onto?
	const vertical = dir === 'down' || dir === 'up';
	const sign = dir === 'left' || dir === 'up' ? -1 : 1;

	const extents = new Map<string, number>();
	const depths = new Map<string, number>();
	const visited = new Set<string>();

	const measure = (id: string, d: number, stack: Set<string>): number => {
		const node = byId.get(id);
		if (!node) return 0;
		if (stack.has(id)) return geo.siblingExtent(node);
		if (extents.has(id)) return extents.get(id)!;
		stack.add(id);
		depths.set(id, d);
		visited.add(id);

		const self = geo.siblingExtent(node);
		const kids = children.get(id) ?? [];
		let total = 0;
		for (const k of kids) total += measure(k, d + 1, stack) + geo.siblingStep;
		if (total > 0) total -= geo.siblingStep;

		stack.delete(id);
		const extent = Math.max(self, total);
		extents.set(id, extent);
		return extent;
	};

	const roots = rootsOverride ?? tree.roots;
	for (const r of roots) measure(r, 0, new Set());

	// any node not reached becomes its own root
	for (const n of nodes) {
		if (!visited.has(n.id)) {
			roots.push(n.id);
			measure(n.id, 0, new Set());
		}
	}

	const placed = new Map<string, { x: number; y: number }>();

	const place = (id: string, start: number, stack: Set<string>): void => {
		if (stack.has(id)) return;
		const node = byId.get(id);
		if (!node) return;
		stack.add(id);

		const selfExtent = geo.siblingExtent(node);
		const boxExtent = extents.get(id) ?? selfExtent;
		const d = depths.get(id) ?? 0;

		// centre the node inside its subtree box
		const siblingPos = start + (boxExtent - selfExtent) / 2;
		const depthPos = d * geo.depthStep;

		if (vertical) {
			placed.set(id, {
				x: origin.x + siblingPos,
				y: origin.y + sign * depthPos,
			});
		} else {
			placed.set(id, {
				x: origin.x + sign * depthPos,
				y: origin.y + siblingPos,
			});
		}

		const kids = children.get(id) ?? [];
		let cursor = start + (boxExtent - (kids.reduce((s, k) => s + (extents.get(k) ?? 0) + geo.siblingStep, 0) - geo.siblingStep)) / 2;
		for (const k of kids) {
			place(k, cursor, stack);
			cursor += (extents.get(k) ?? 0) + geo.siblingStep;
		}

		stack.delete(id);
	};

	let cursor = 0;
	for (const r of roots) {
		place(r, cursor, new Set());
		cursor += (extents.get(r) ?? 60) + geo.siblingStep * 3;
	}

	return placed;
}

/**
 * Recompute each node's `tone` from its real depth in the tree.
 *
 * tone drives the node colour (root = accent, branch = tinted, leaf = white), so
 * it must follow the structure. Setting it only at creation time meant a node
 * dragged under the root kept its old white "leaf" look — the "有些节点是主题色
 * 有些是白色" inconsistency.
 */
export function syncTones(nodes: MindNode[], edges: Edge[]): MindNode[] {
	const tree = buildTree(nodes, edges);
	const depth = new Map<string, number>();

	const walk = (id: string, d: number, stack: Set<string>) => {
		if (stack.has(id)) return;
		stack.add(id);
		depth.set(id, d);
		for (const k of tree.children.get(id) ?? []) walk(k, d + 1, stack);
		stack.delete(id);
	};

	for (const r of tree.roots) walk(r, 0, new Set());
	// detached nodes are their own roots
	for (const n of nodes) {
		if (!depth.has(n.id)) walk(n.id, 0, new Set());
	}

	return nodes.map((n) => {
		const d = depth.get(n.id) ?? 0;
		const tone: 'root' | 'branch' | 'leaf' = d === 0 ? 'root' : d === 1 ? 'branch' : 'leaf';
		if (n.data?.tone === tone) return n;
		return { ...n, data: { ...n.data, tone } };
	});
}

/** Split the root's children into a left and a right half for the two-sided layouts. */
function splitSides(childrenOfRoot: string[]): { right: string[]; left: string[] } {
	const right: string[] = [];
	const left: string[] = [];
	childrenOfRoot.forEach((id, i) => {
		// alternate but keep the first half on the right so reading order is natural
		if (i % 2 === 0) right.push(id);
		else left.push(id);
	});
	return { right, left };
}

/**
 * Two-sided layout (两侧平衡图): root in the middle, children split left/right.
 *
 * Both halves are laid out independently with the root at x = 0:
 *  - the right half grows to +x
 *  - the left half is MIRRORED to -x (otherwise both halves overlap on the
 *    right side of the root, which is what made the structure look broken)
 * Then the halves are aligned vertically on the root's own y.
 */
function layoutTwoSided(
	nodes: MindNode[],
	tree: Tree,
	rootId: string,
): Map<string, { x: number; y: number }> {
	const kids = tree.children.get(rootId) ?? [];
	const { right, left } = splitSides(kids);

	// Deep-copy the children map (including every array) before overriding the
	// root's list. A shallow `new Map(tree.children)` shares the arrays, so
	// setting one tree's root children would also change the other's.
	const cloneChildren = () => {
		const m = new Map<string, string[]>();
		for (const [k, v] of tree.children) m.set(k, [...v]);
		return m;
	};

	const rightTree: Tree = { ...tree, children: cloneChildren() };
	rightTree.children.set(rootId, [...right]);
	const leftTree: Tree = { ...tree, children: cloneChildren() };
	leftTree.children.set(rootId, [...left]);

	const rightMap = layoutDirected(nodes, rightTree, 'right', { x: 0, y: 0 }, [rootId]);
	const leftMap = layoutDirected(nodes, leftTree, 'left', { x: 0, y: 0 }, [rootId]);

	// In both maps the root sits at x = 0. Align the halves vertically by the
	// root's own y so no connector has to travel up/down just to reach the root.
	const rootRightY = rightMap.get(rootId)?.y ?? 0;
	const rootLeftY = leftMap.get(rootId)?.y ?? 0;

	// Collect the ids that belong to each half. This matters: `layoutDirected`
	// also places nodes it never visited (they default to x = 0, i.e. on top of
	// the root), so blindly merging both maps would overwrite the right half's
	// real positions with those placeholders.
	const rightSet = new Set<string>();
	const collect = (id: string) => {
		if (rightSet.has(id)) return;
		rightSet.add(id);
		for (const k of rightTree.children.get(id) ?? []) collect(k);
	};
	collect(rootId);

	const leftSet = new Set<string>();
	const collectLeft = (id: string) => {
		if (leftSet.has(id) || id === rootId) return;
		leftSet.add(id);
		for (const k of leftTree.children.get(id) ?? []) collectLeft(k);
	};
	for (const k of leftTree.children.get(rootId) ?? []) collectLeft(k);

	const placed = new Map<string, { x: number; y: number }>();
	for (const [id, p] of rightMap) {
		if (!rightSet.has(id) && id !== rootId) continue;
		placed.set(id, { x: p.x, y: p.y - rootRightY });
	}
	for (const [id, p] of leftMap) {
		if (!leftSet.has(id)) continue;
		placed.set(id, { x: p.x, y: p.y - rootLeftY });
	}
	return placed;
}

/**
 * Fishbone layout (鱼骨图): the root is the "head" on the left, a horizontal
 * spine runs right, and top-level branches alternate above / below the spine.
 * Each branch's descendants stack further away from the spine.
 *
 * This is a genuinely different shape from the two-sided layout — it used to be
 * a copy of it, which is why it looked broken.
 */
function layoutFishbone(
	nodes: MindNode[],
	tree: Tree,
	rootId: string,
): Map<string, { x: number; y: number }> {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const root = byId.get(rootId);
	if (!root) return layoutDirected(nodes, tree, 'right', { x: 0, y: 0 });

	const RIB_STEP = 74; // vertical distance from the spine to a rib's node
	const LEVEL_STEP = 84; // extra vertical distance per deeper level
	const SLOT_GAP = 34; // horizontal gap between rib slots
	const DEPTH_INDENT = 54; // deeper levels shift right, so bones read diagonally

	// horizontal extent each subtree needs
	const widths = new Map<string, number>();
	const measureWidth = (id: string, stack: Set<string>): number => {
		if (widths.has(id)) return widths.get(id)!;
		if (stack.has(id)) return NODE_WIDTH;
		stack.add(id);
		const kids = tree.children.get(id) ?? [];
		let total = 0;
		for (const k of kids) total += measureWidth(k, stack) + SLOT_GAP;
		if (total > 0) total -= SLOT_GAP;
		stack.delete(id);
		const w = Math.max(NODE_WIDTH, total);
		widths.set(id, w);
		return w;
	};

	const kids = tree.children.get(rootId) ?? [];
	for (const k of kids) measureWidth(k, new Set());

	const placed = new Map<string, { x: number; y: number }>();

	// head: vertically centred on the spine (spine y = 0)
	const rootH = estimateHeight(root);
	placed.set(rootId, { x: 0, y: -rootH / 2 });

	/**
	 * Place one rib (a top-level branch) and its subtree inside its horizontal
	 * slot. `dir` is -1 above the spine, +1 below.
	 *
	 * Deeper levels move away from the spine AND shift right, so the bones read as
	 * a fish skeleton rather than a plain indented tree.
	 */
	const placeRib = (id: string, startX: number, dir: number, level: number): void => {
		const w = widths.get(id) ?? NODE_WIDTH;
		const nodeH = estimateHeight(byId.get(id)!);
		const depth = RIB_STEP + (level - 1) * LEVEL_STEP;

		// horizontally centre inside the slot, then indent deeper levels rightwards
		const x = startX + (w - NODE_WIDTH) / 2 + (level - 1) * DEPTH_INDENT;
		// above the spine the box grows upward, below it grows downward
		const y = dir < 0 ? -depth - nodeH : depth;
		placed.set(id, { x, y });

		const children = tree.children.get(id) ?? [];
		if (!children.length) return;

		const total =
			children.reduce((s, k) => s + (widths.get(k) ?? NODE_WIDTH) + SLOT_GAP, 0) - SLOT_GAP;
		let cursor = startX + Math.max(0, (w - total) / 2);
		for (const k of children) {
			placeRib(k, cursor, dir, level + 1);
			cursor += (widths.get(k) ?? NODE_WIDTH) + SLOT_GAP;
		}
	};

	// Lay the ribs out left-to-right, alternating above/below the spine so the
	// bone pattern is balanced on both sides.
	let cursor = NODE_WIDTH + 70; // leave room for the head
	kids.forEach((id, i) => {
		const dir = i % 2 === 0 ? -1 : 1;
		placeRib(id, cursor, dir, 1);
		cursor += (widths.get(id) ?? NODE_WIDTH) + SLOT_GAP;
	});

	// detached nodes become free-floating roots near the origin
	for (const n of nodes) {
		if (!placed.has(n.id)) placed.set(n.id, { x: 0, y: 0 });
	}

	return placed;
}

/**
 * Layout the whole map using the chosen structure.
 *
 * `structure` defaults to the classic left-to-right mind map, so existing
 * documents render exactly as before.
 */
export function layoutTree(
	nodes: MindNode[],
	edges: Edge[],
	structure: StructureId = DEFAULT_STRUCTURE,
): MindNode[] {
	if (!nodes.length) return nodes;

	const tree = buildTree(nodes, edges);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const sid = getStructure(structure);

	let positioned: Map<string, { x: number; y: number }>;

	switch (sid) {
		case 'left':
			positioned = layoutDirected(nodes, tree, 'left', { x: 0, y: 0 });
			break;

		case 'down':
			positioned = layoutDirected(nodes, tree, 'down', { x: 0, y: 0 });
			break;

		case 'up':
			positioned = layoutDirected(nodes, tree, 'up', { x: 0, y: 0 });
			break;

		case 'both': {
			const rootId = tree.roots[0];
			if (!rootId) {
				positioned = layoutDirected(nodes, tree, 'right', { x: 0, y: 0 });
				break;
			}
			positioned = layoutTwoSided(nodes, tree, rootId);
			break;
		}

		case 'fishbone': {
			const rootId = tree.roots[0];
			if (!rootId) {
				positioned = layoutDirected(nodes, tree, 'right', { x: 0, y: 0 });
				break;
			}
			positioned = layoutFishbone(nodes, tree, rootId);
			break;
		}

		case 'right':
		case 'balanced':
		default:
			positioned = layoutDirected(nodes, tree, 'right', { x: 0, y: 0 });
			break;
	}

	// normalise: shift everything so the top-left of the bounding box is (0,0)
	let minX = Infinity;
	let minY = Infinity;
	for (const p of positioned.values()) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
	}
	if (Number.isFinite(minX)) {
		for (const [id, p] of positioned) {
			positioned.set(id, { x: p.x - minX, y: p.y - minY });
		}
	}

	const laidOut = nodes.map((n) => {
		const p = positioned.get(n.id);
		return p ? { ...n, position: p } : n;
	});

	// tone must reflect the CURRENT depth, not whatever it was when created
	return syncTones(laidOut, edges);
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

/** Direct children of a node, in edge order. */
export function childrenOf(edges: Edge[], parentId: string): string[] {
	return edges.filter((e) => e.source === parentId).map((e) => e.target);
}

/** Parent of a node, if any. */
export function parentOf(edges: Edge[], nodeId: string): string | undefined {
	return edges.find((e) => e.target === nodeId)?.source;
}

/** True when `ancestorId` is an ancestor of (or equal to) `nodeId`. */
export function isAncestor(edges: Edge[], ancestorId: string, nodeId: string): boolean {
	if (ancestorId === nodeId) return true;
	let cur = parentOf(edges, nodeId);
	const seen = new Set<string>();
	while (cur) {
		if (cur === ancestorId) return true;
		if (seen.has(cur)) return false;
		seen.add(cur);
		cur = parentOf(edges, cur);
	}
	return false;
}
