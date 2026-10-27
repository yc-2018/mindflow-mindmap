import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';
import { DEFAULT_STRUCTURE, getStructure, type Direction, type StructureId } from './structures';

/** Node box geometry used by the auto-layout. */
export const NODE_WIDTH = 210;
const H_GAP = 76;
const V_GAP = 22;

/**
 * Typography used by the node label. These must match `styles.css`
 * (.md-label / .mind-node__label) — the layout reserves space based on them, so
 * a mismatch shows up as overlapping nodes.
 */
const LABEL_FONT_SIZE = 13.5;
const LABEL_LINE_HEIGHT = 1.45;
const LABEL_PADDING_Y = 9; // padding: 9px 12px
const LABEL_MIN_HEIGHT = 36;
const NODE_BORDER = 1.5;

/** Horizontal padding inside a node (12px each side) plus the border. */
const LABEL_PADDING_X = 12;

/** Height of the image row: 40px thumbnails + 9px bottom padding. */
const IMAGE_BLOCK = 49;

/**
 * Average glyph width as a fraction of the font size.
 *
 * CJK glyphs are full-width (~1.0em), Latin/ASCII average ~0.55em. Using a
 * single guess either over-reserves for English or under-reserves for Chinese,
 * and under-reserving is what caused nodes to grow into their neighbours.
 */
const CJK_RATIO = 1.0;
const LATIN_RATIO = 0.56;

/** Approximate rendered width of one character, in px. */
function charWidth(ch: string): number {
	// CJK, full-width punctuation, emoji and other wide codepoints
	if (/[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)) {
		return LABEL_FONT_SIZE * CJK_RATIO;
	}
	return LABEL_FONT_SIZE * LATIN_RATIO;
}

/**
 * Strip the markdown/HTML decoration that does not occupy visible width.
 *
 * `**bold**` renders as `bold`, `<u>x</u>` as `x`, `- item` as `item`, so the
 * raw string is a poor width estimate. Without this, short formatted labels were
 * measured far too wide (and vice versa for long ones).
 */
function plainText(label: string): string {
	return label
		.replace(/<\/?[a-zA-Z][^>]*>/g, '') // HTML tags
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/~~(.+?)~~/g, '$1')
		.replace(/==(.+?)==/g, '$1')
		.replace(/`(.+?)`/g, '$1')
		.replace(/(^|\s)[*_](.+?)[*_](\s|$)/g, '$1$2$3')
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '') // list markers
		.replace(/^\s*#{1,6}\s+/gm, '') // headings
		.replace(/^\s*>\s?/gm, ''); // quotes
}

/**
 * Number of rendered lines a label needs inside a node of `NODE_WIDTH`.
 *
 * Walks the text character by character, wrapping at the node's inner width.
 * This replaces the old "every 8 chars = one line" heuristic, which was badly
 * wrong for Chinese (8 chars is nearly a full line) and for mixed text.
 */
export function countLines(label: string): number {
	const text = plainText(label ?? '');
	if (!text) return 1;

	const innerWidth = NODE_WIDTH - LABEL_PADDING_X * 2 - NODE_BORDER * 2;
	let lines = 0;

	for (const paragraph of text.split('\n')) {
		if (!paragraph) {
			lines += 1; // an empty line still occupies a row
			continue;
		}
		let current = 0;
		let rowCount = 1;
		for (const ch of paragraph) {
			const w = charWidth(ch);
			if (current + w > innerWidth) {
				rowCount += 1;
				current = w;
			} else {
				current += w;
			}
		}
		lines += rowCount;
	}

	return Math.max(1, lines);
}

/**
 * Estimated rendered height of a node.
 *
 * Kept in sync with the real DOM: label padding + line box + optional image row.
 * The layout uses this to space siblings, so underestimating it makes nodes
 * overlap their neighbours — exactly the reported bug when text wrapped.
 */
export function estimateHeight(node: MindNode): number {
	const lines = countLines(node.data?.label ?? '');
	const lineHeight = LABEL_FONT_SIZE * LABEL_LINE_HEIGHT;
	const textBlock = Math.max(
		LABEL_MIN_HEIGHT,
		lines * lineHeight + LABEL_PADDING_Y * 2,
	);
	const imgH = (node.data?.images?.length ?? 0) > 0 ? IMAGE_BLOCK : 0;
	// +1px slack absorbs sub-pixel rounding differences between estimate and DOM
	return Math.ceil(textBlock + imgH + NODE_BORDER * 2) + 1;
}

/**
 * Height of a node including a safety gap, used when packing siblings.
 *
 * Real nodes can render slightly taller than the estimate (font fallback,
 * markdown blocks with extra margins). A small extra gap keeps the layout from
 * ever producing touching boxes.
 */
function slotHeight(node: MindNode): number {
	return estimateHeight(node) + 6;
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
		siblingExtent: (n) => slotHeight(n),
	},
	left: {
		depthStep: NODE_WIDTH + H_GAP,
		siblingStep: V_GAP,
		siblingExtent: (n) => slotHeight(n),
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
 * Pick the map's PRIMARY root.
 *
 * `tree.roots[0]` is just the first parentless node in declaration order, which
 * can easily be a detached node that happens to come first. Structures like the
 * fishbone then treat that orphan as the "head" and squeeze the real tree into
 * the leftovers grid.
 *
 * So we choose the root whose subtree contains the most nodes — the actual
 * centre of the map. Ties fall back to declaration order.
 */
function primaryRoot(tree: Tree, nodes: MindNode[]): string | undefined {
	if (!tree.roots.length) return undefined;
	const sizeOf = new Map<string, number>();

	const count = (id: string, stack: Set<string>): number => {
		if (stack.has(id)) return 0;
		stack.add(id);
		let n = 1;
		for (const k of tree.children.get(id) ?? []) n += count(k, stack);
		stack.delete(id);
		return n;
	};

	let best = tree.roots[0];
	let bestSize = -1;
	for (const r of tree.roots) {
		const size = count(r, new Set());
		sizeOf.set(r, size);
		if (size > bestSize) {
			bestSize = size;
			best = r;
		}
	}
	void nodes;
	return best;
}

/**
 * Lay out every node the caller did not reach.
 *
 * These are detached roots: nodes whose parent chain is broken, or that were
 * dragged off on their own. Leaving them unpositioned made them all pile up at
 * one point on top of the map (the "独立节点全部叠在一起" bug), so we arrange
 * them in a tidy grid below everything else, each keeping its own subtree.
 *
 * Mutates `placed` and returns it for convenience.
 */
function placeLeftovers(
	nodes: MindNode[],
	tree: Tree,
	placed: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
	const leftovers = nodes.filter((n) => !placed.has(n.id));
	if (!leftovers.length) return placed;

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const leftoverSet = new Set(leftovers.map((n) => n.id));

	// only the ROOTS of the leftover forest; children follow their parent
	const hasParentInside = new Set<string>();
	for (const [parent, kids] of tree.children) {
		if (!leftoverSet.has(parent)) continue;
		for (const k of kids) if (leftoverSet.has(k)) hasParentInside.add(k);
	}
	const orphanRoots = leftovers.filter((n) => !hasParentInside.has(n.id));

	// start below whatever is already placed so the grid never overlaps
	let lowest = 0;
	for (const p of placed.values()) lowest = Math.max(lowest, p.y);
	const startY = lowest + 90;

	const COLS = 4;
	const COL_W = NODE_WIDTH + 56;
	const ROW_H = 110;

	/** Vertical stack for one orphan subtree; returns the y after its last node. */
	const placeStack = (id: string, x: number, y: number): number => {
		const node = byId.get(id);
		if (!node) return y;
		const h = slotHeight(node);
		placed.set(id, { x, y });
		let nextY = y + h + 16;
		for (const k of tree.children.get(id) ?? []) {
			nextY = placeStack(k, x + 24, nextY); // slight indent for children
		}
		return nextY;
	};

	let col = 0;
	let row = 0;
	for (const root of orphanRoots) {
		const endY = placeStack(root.id, col * COL_W, startY + row * ROW_H);
		col += 1;
		if (col >= COLS) {
			col = 0;
			row += 1;
		} else if (endY > startY + (row + 1) * ROW_H) {
			// a tall stack consumes extra rows so the next cell cannot collide
			row += Math.ceil((endY - startY) / ROW_H) - row;
			col = 0;
		}
	}

	return placed;
}

/**
 * Split the root's children into a left and a right half for the two-sided
 * layouts.
 *
 * Side is decided in this priority order:
 *  1. an explicit `data.side` flag (set when the user switches to this
 *     structure, or by dragging a node across the root)
 *  2. the node's current x relative to the root
 *  3. balancing whichever half has fewer children
 *
 * The old implementation alternated purely by index, so adding one child
 * shifted every later child's parity — the entire map flipped sides and looked
 * scrambled. Priority 1+2 keep existing nodes where they already are.
 */
function splitSides(
	childrenOfRoot: string[],
	byId: Map<string, MindNode>,
	rootX: number,
): { right: string[]; left: string[] } {
	const right: string[] = [];
	const left: string[] = [];

	for (const id of childrenOfRoot) {
		const node = byId.get(id);
		const flag = node?.data?.side;
		if (flag === 'left') {
			left.push(id);
			continue;
		}
		if (flag === 'right') {
			right.push(id);
			continue;
		}

		const x = node?.position?.x;
		if (typeof x === 'number' && Number.isFinite(x) && Math.abs(x - rootX) > 1) {
			// keep it on the side it already occupies
			if (x > rootX) right.push(id);
			else left.push(id);
			continue;
		}

		// unknown position: balance the halves
		if (right.length <= left.length) right.push(id);
		else left.push(id);
	}

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
	const rootNode = nodes.find((n) => n.id === rootId);
	const rootX = rootNode?.position?.x ?? 0;
	const byIdAll = new Map(nodes.map((n) => [n.id, n]));
	const { right, left } = splitSides(kids, byIdAll, rootX);

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

	// Detached nodes belong to neither half, so they must be laid out separately
	// — otherwise they all end up unpositioned and stack on top of each other.
	placeLeftovers(nodes, tree, placed);
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

	const HEAD_W = NODE_WIDTH;
	const BRANCH_GAP = 40; // gap between the head and the first rib
	const RIB_STEP = 74; // vertical distance from the spine to a rib's node
	const LEVEL_STEP = 84; // extra distance per deeper level
	const SLOT_GAP = 34; // horizontal gap between rib slots
	const DEPTH_INDENT = 54; // deeper levels shift right, so bones read diagonally

	// horizontal slot width each subtree needs
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

	// The spine is the horizontal line at y = 0. The head straddles it.
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
	let cursor = HEAD_W + 70; // leave room for the head
	kids.forEach((id, i) => {
		const dir = i % 2 === 0 ? -1 : 1;
		placeRib(id, cursor, dir, 1);
		cursor += (widths.get(id) ?? NODE_WIDTH) + SLOT_GAP;
	});

	/**
	 * Place every node the fishbone did not reach.
	 *
	 * These are detached roots (their parent chain is broken, or they were
	 * dragged off on their own). Dumping them all at (0,0) stacked them into one
	 * pile on top of the head, so they go into a tidy grid below the spine.
	 */
	placeLeftovers(nodes, tree, placed);

	return placed;
}

/**
 * Layout the whole map using the chosen structure.
 *
 * `structure` defaults to the classic left-to-right mind map, so existing
 * documents render exactly as before.
 *
 * `options.keepPinned` (default true) preserves nodes the user dragged to a
 * custom spot. Explicit "整理布局" / structure switches pass `false` so the layout
 * can actually rearrange everything — otherwise a map full of accidentally
 * pinned nodes would ignore the button entirely.
 */
export function layoutTree(
	nodes: MindNode[],
	edges: Edge[],
	structure: StructureId = DEFAULT_STRUCTURE,
	options: { keepPinned?: boolean } = {},
): MindNode[] {
	if (!nodes.length) return nodes;

	const keepPinned = options.keepPinned !== false;
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
			const rootId = primaryRoot(tree, nodes);
			if (!rootId) {
				positioned = layoutDirected(nodes, tree, 'right', { x: 0, y: 0 });
				break;
			}
			positioned = layoutTwoSided(nodes, tree, rootId);
			break;
		}

		case 'fishbone': {
			const rootId = primaryRoot(tree, nodes);
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

	/**
	 * Anchor the layout to the map's existing root position.
	 *
	 * The old code shifted everything so the bounding box's top-left landed at
	 * (0,0). Every time the map grew to the LEFT (a new node on the left half), the
	 * bounding box widened, so the whole map jumped sideways — the root appeared to
	 * leap to a new spot even though nothing had actually moved relative to it.
	 *
	 * Instead we keep the root where it already is, so adding nodes on either side
	 * only extends outward and the existing layout stays visually still.
	 */
	const anchorId = primaryRoot(tree, nodes);
	const anchorNode = anchorId ? byId.get(anchorId) : undefined;
	const anchorPos = anchorId ? positioned.get(anchorId) : undefined;

	if (anchorNode && anchorPos && Number.isFinite(anchorNode.position?.x)) {
		const dx = anchorNode.position.x - anchorPos.x;
		const dy = anchorNode.position.y - anchorPos.y;
		if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
			for (const [id, p] of positioned) {
				positioned.set(id, { x: p.x + dx, y: p.y + dy });
			}
		}
	} else {
		// no usable anchor (fresh map): fall back to bounding-box normalisation
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
	}

	const laidOut = nodes.map((n) => {
		// A pinned node keeps the position the user dragged it to; the auto-layout
		// must not pull it back. Its children are still laid out relative to the
		// tree, which is why only the pinned node itself is exempt.
		// `keepPinned: false` (explicit layout commands) overrides this.
		if (
			keepPinned &&
			n.data?.pinned &&
			Number.isFinite(n.position?.x) &&
			Number.isFinite(n.position?.y)
		) {
			return n;
		}
		const p = positioned.get(n.id);
		if (!p) return n;
		// a pinned node that is being re-laid-out must lose the flag, or the next
		// layout would skip it again
		const data = n.data?.pinned ? { ...n.data, pinned: false } : n.data;
		return { ...n, position: p, data };
	});

	// tone must reflect the CURRENT depth, not whatever it was when created
	return syncTones(laidOut, edges);
}

/**
 * Recompute each node's `tone` from its real depth in the tree.
 *
 * tone drives the node colour (root = accent, branch = tinted, leaf = white), so
 * it must follow the structure. Setting it only at creation time meant a node
 * dragged under the root kept its old white "leaf" look — the "有些节点是主题色
 * 有些是白色" inconsistency.
 *
 * Also stamps `branchIndex`: the ordinal of the node's top-level branch among the
 * root's direct children. Rainbow themes use it to give each branch its own hue,
 * and descendants inherit their branch's index.
 */
export function syncTones(nodes: MindNode[], edges: Edge[]): MindNode[] {
	const tree = buildTree(nodes, edges);
	const depth = new Map<string, number>();
	/** Which forest root each node descends from. */
	const rootOf = new Map<string, string>();
	/** Top-level branch ordinal (null for a root itself). */
	const branchIndex = new Map<string, number | null>();

	const walk = (id: string, d: number, rootId: string, branch: number | null, stack: Set<string>) => {
		if (stack.has(id)) return;
		stack.add(id);
		depth.set(id, d);
		rootOf.set(id, rootId);
		branchIndex.set(id, branch);
		for (const k of tree.children.get(id) ?? []) walk(k, d + 1, rootId, branch, stack);
		stack.delete(id);
	};

	const primary = primaryRoot(tree, nodes);

	for (const r of tree.roots) {
		// walk the root FIRST (branchIndex null), then each child subtree with its
		// own ordinal. Doing it the other way round would have the root's walk
		// overwrite every child's branchIndex with null.
		walk(r, 0, r, null, new Set());
		const kids = tree.children.get(r) ?? [];
		kids.forEach((k, i) => walk(k, 1, r, i, new Set()));
	}

	// detached nodes are their own roots
	for (const n of nodes) {
		if (!depth.has(n.id)) {
			walk(n.id, 0, n.id, null, new Set());
			const kids = tree.children.get(n.id) ?? [];
			kids.forEach((k, i) => walk(k, 1, n.id, i, new Set()));
		}
	}

	return nodes.map((n) => {
		const d = depth.get(n.id) ?? 0;
		let tone: 'root' | 'branch' | 'leaf';
		if (d === 0) {
			// the primary root is "root"; a detached tree's root reads as a branch
			tone = n.id === primary ? 'root' : 'branch';
		} else if (d === 1) {
			tone = 'branch';
		} else {
			tone = 'leaf';
		}
		const bi = branchIndex.get(n.id) ?? null;
		if (n.data?.tone === tone && n.data?.branchIndex === bi) return n;
		return { ...n, data: { ...n.data, tone, branchIndex: bi } };
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
