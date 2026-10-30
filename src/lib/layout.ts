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

	/**
	 * Only lay out the PRIMARY root's tree here.
	 *
	 * `tree.roots` also contains detached nodes (any node without a parent). If we
	 * place them too, they end up stacked in the same column as the real root —
	 * the "整理布局 缩成一团" pile. They are handed to `placeLeftovers` instead,
	 * which lays each detached branch out as its own small map to the right.
	 */
	const primary = primaryRoot(tree, nodes);
	const roots: string[] = rootsOverride ?? (primary ? [primary] : []);
	for (const r of roots) measure(r, 0, new Set());

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

	// detached branches get their own row, right of the main map
	placeLeftovers(nodes, tree, placed);

	return placed;
}

/**
 * Pick the map's PRIMARY root.
 *
 * `tree.roots[0]` is just the first parentless node in declaration order, which
 * can easily be a detached node that happens to come first.
 *
 * Priority:
 *  1. a node explicitly carrying `tone: 'root'` — that is the real centre of the
 *     map, set when the document was created and preserved by `syncTones`
 *  2. the root whose subtree contains the most nodes
 *
 * Rule 1 matters because "most nodes" alone is wrong: a detached branch with
 * three children outvoted the actual root with two, so 整理布局 treated the
 * detached branch as the centre and piled everything around it — the reported
 * "脱离的节点变成根节点, 整理布局就缩成一团".
 */
function primaryRoot(tree: Tree, nodes: MindNode[]): string | undefined {
	if (!tree.roots.length) return undefined;

	// 1. explicit root marker
	const marked = tree.roots.filter((r) => nodes.find((n) => n.id === r)?.data?.tone === 'root');
	if (marked.length) {
		// if several are marked (rare), take the biggest one
		if (marked.length === 1) return marked[0];
		let bestMarked = marked[0];
		let bestMarkedSize = -1;
		for (const r of marked) {
			const size = subtreeSize(tree, r);
			if (size > bestMarkedSize) {
				bestMarkedSize = size;
				bestMarked = r;
			}
		}
		return bestMarked;
	}

	// 2. fall back to the largest subtree
	let best = tree.roots[0];
	let bestSize = -1;
	for (const r of tree.roots) {
		const size = subtreeSize(tree, r);
		if (size > bestSize) {
			bestSize = size;
			best = r;
		}
	}
	return best;
}

/** How many nodes live in the subtree rooted at `id` (inclusive). */
function subtreeSize(tree: Tree, id: string, stack = new Set<string>()): number {
	if (stack.has(id)) return 0;
	stack.add(id);
	let n = 1;
	for (const k of tree.children.get(id) ?? []) n += subtreeSize(tree, k, stack);
	stack.delete(id);
	return n;
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
/**
 * Place subtrees that the main layout did not reach — detached nodes and their
 * descendants.
 *
 * These used to be dropped into a grid whose first cell sat at x = 0, i.e. the
 * SAME column as the main root. With one root that never showed, but as soon as
 * a node was detached the map became a narrow vertical pile: the detached
 * subtrees stacked directly under the root ("整理布局 缩成一团").
 *
 * Now they are laid out as proper little mind maps, in a row BELOW the main map,
 * each growing to the right and separated horizontally. That keeps the whole map
 * wide and readable no matter how many detached branches exist.
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

	// Start BELOW and to the RIGHT of whatever is already placed.
	//
	// The main layout's coordinates are relative to its own root, so a detached
	// subtree placed at the main map's left edge ended up in the same column as
	// the root — which is exactly the "缩成一团" pile. Anchoring to the right of
	// the main map keeps the result wide.
	let maxY = 0;
	let maxX = 0;
	let minX = 0;
	let have = false;
	for (const p of placed.values()) {
		if (!have) {
			maxY = p.y;
			maxX = p.x;
			minX = p.x;
			have = true;
			continue;
		}
		maxY = Math.max(maxY, p.y);
		maxX = Math.max(maxX, p.x);
		minX = Math.min(minX, p.x);
	}

	const GAP_Y = 150; // between the main map and the row of detached branches
	const GAP_X = 90; // between two detached subtrees
	const CHILD_GAP = 24; // between siblings inside one detached subtree
	const DEPTH = NODE_WIDTH + 76;

	const kidsOf = (id: string) => (tree.children.get(id) ?? []).filter((k) => leftoverSet.has(k));

	/** How many levels the subtree under `id` has (0 = leaf). */
	const depthOf = (id: string): number => {
		const kids = kidsOf(id);
		if (!kids.length) return 0;
		return 1 + Math.max(...kids.map(depthOf));
	};

	/** Total height of the subtree under `id`. */
	const heightOf = (id: string): number => {
		const node = byId.get(id);
		if (!node) return 0;
		const kids = kidsOf(id);
		const self = slotHeight(node);
		if (!kids.length) return self;
		let sum = 0;
		for (const k of kids) sum += heightOf(k) + CHILD_GAP;
		return Math.max(self, sum - CHILD_GAP);
	};

	/**
	 * Lay out one subtree growing to the RIGHT, each level one column further.
	 *
	 * The parent is aligned with its FIRST child rather than centred on the whole
	 * band. Centring pushed the parent's centre far above/below its children when
	 * there were only two of them, which made the connector look vertical and
	 * fold back — the tangle in the screenshot. Aligning with the first child
	 * keeps every connector a clean horizontal run.
	 */
	const placeSubtree = (id: string, x: number, yTop: number): void => {
		const node = byId.get(id);
		if (!node) return;
		const h = heightOf(id);
		const kids = kidsOf(id);

		// a leaf fills its band; a parent sits level with its first child
		const selfY = kids.length ? yTop : yTop + (h - slotHeight(node)) / 2;
		placed.set(id, { x, y: selfY });

		if (!kids.length) return;
		let childY = yTop;
		for (const k of kids) {
			placeSubtree(k, x + DEPTH, childY);
			childY += heightOf(k) + CHILD_GAP;
		}
	};

	const MAX_ROW_W = 2600;
	let cursorX = maxX + GAP_X;
	let rowTop = maxY + GAP_Y;
	let rowHeight = 0;

	for (const root of orphanRoots) {
		const w = NODE_WIDTH + depthOf(root.id) * DEPTH;
		// wrap only when this is not the first subtree of the row
		if (cursorX > maxX + GAP_X && cursorX + w - (maxX + GAP_X) > MAX_ROW_W) {
			rowTop += rowHeight + GAP_Y;
			cursorX = maxX + GAP_X;
			rowHeight = 0;
		}
		placeSubtree(root.id, cursorX, rowTop);
		rowHeight = Math.max(rowHeight, heightOf(root.id));
		cursorX += w + GAP_X;
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
 * scrambled. Priorities 1+2 keep existing nodes where they already are.
 *
 * Finally, if every child ended up on the SAME side, the stored positions
 * carried no left/right information at all (a freshly created map places each
 * child to the right of its parent, so all of them look "right"). A two-sided
 * layout with an empty half is just a one-sided map — the reported "两侧平衡图
 * 全部在一边" — so in that case we distribute by order instead.
 */
function splitSides(
	childrenOfRoot: string[],
	byId: Map<string, MindNode>,
	rootX: number,
): { right: string[]; left: string[] } {
	const right: string[] = [];
	const left: string[] = [];
	const unknown: string[] = [];

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

		unknown.push(id);
	}

	// nodes with no usable position info: balance the halves
	for (const id of unknown) {
		if (right.length <= left.length) right.push(id);
		else left.push(id);
	}

	/**
	 * Everything on one side means the geometry told us nothing. Alternate by
	 * original order so the map is genuinely two-sided.
	 *
	 * A single child is left alone: there is nothing to balance, and forcing a
	 * side would make a one-node branch jump to the left for no reason.
	 */
	if ((left.length === 0 || right.length === 0) && childrenOfRoot.length > 1) {
		right.length = 0;
		left.length = 0;
		childrenOfRoot.forEach((id, i) => (i % 2 === 0 ? right.push(id) : left.push(id)));
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
 * Fishbone layout (鱼骨图), rebuilt from ProcessOn's own ishikawa rendering.
 *
 * The geometry below was measured off ProcessOn's canvas for a real
 * `mind_ishikawa_left` file (head on the left; ProcessOn documents 左侧鱼骨图
 * as "鱼头在左"), by extracting the exact SVG path coordinates of its viewer:
 *
 *   ┌────┐          ┌──────────┐
 *   │头  │──────────┤ 2023总结 │ ...   ← L1 boxes at the FAR end of a bone
 *   └────┘    ╲  ╲ └──────────┘       ← 60° bones lean AWAY from the head
 *        ┌──────┐
 *        │分支…  │                  ← second level hangs ON the bone
 *        └──────┘
 *
 * The rules that came out of those measurements:
 *
 *  - the spine is ONE horizontal line at the head's vertical centre; the head
 *    straddles it at the far left
 *  - every top-level branch leaves the SPINE (not the head box) as a straight
 *    60° diagonal — up-right for odd branches, down-right for even ones —
 *    with its box at the far end (the bone enters the box's bottom/top edge)
 *  - second-level topics hang on the bone: a HORIZONTAL rib leaves the bone at
 *    the box's level and reaches its left edge, so those boxes stagger along
 *    the diagonal (each row's column starts where the bone crosses the row's
 *    far edge, plus a gap)
 *  - third level and deeper grow right as a compact tidy tree
 *  - a bone's length is derived from its stack: spine→30px→rib rows→20px→box
 *
 * What makes it read as a fish instead of the old "long strip": the branch
 * boxes alternate ABOVE and BELOW the spine instead of sitting in a row on it,
 * and their bones are visible diagonals instead of horizontal columns.
 *
 * Alternating bones live on opposite sides of the spine, so they may share
 * horizontal space freely; same-side bones are packed so each one's whole
 * footprint (its diagonal, box and rib columns) clears the previous one's.
 */
function layoutFishbone(
	nodes: MindNode[],
	tree: Tree,
	rootId: string,
): Map<string, { x: number; y: number }> {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const root = byId.get(rootId);
	if (!root) return layoutDirected(nodes, tree, 'right', { x: 0, y: 0 });

	// ---- geometry constants (spine-relative; measured off ProcessOn) ----
	/** A 60° bone rises V over V·TAN30 horizontally. */
	const TAN30 = 1 / Math.sqrt(3);
	const SPINE_GAP = 30; // spine -> nearest rib content (or the box, when childless)
	const BOX_GAP = 20; // rib stack -> the L1 box
	const RIB_GAP = 20; // bone crossing -> the rib column's left edge
	const BAND_GAP = 10; // between two rib rows stacked along one bone
	const STACK_GAP = 22; // between two sibling bands inside a rib subtree
	const COL_GAP = 40; // between rib columns
	const PAIR_GAP = 20; // a down-bone's foot vs its up-bone pair's foot
	const SIDE_GAP = 48; // between two same-side bones' footprints
	const FIRST_GAP = 50; // head right edge -> the first bone's foot
	const HEAD_CLEAR = 24; // a box may not reach into the head's column

	/**
	 * Tidy band height of a rib subtree: the node's own slot, or the stack of
	 * its children's bands. `placeRib` mirrors this exactly.
	 */
	const bandCache = new Map<string, number>();
	const bandH = (id: string, stack: Set<string> = new Set()): number => {
		const hit = bandCache.get(id);
		if (hit !== undefined) return hit;
		const node = byId.get(id);
		if (!node) return 0;
		if (stack.has(id)) return slotHeight(node);
		stack.add(id);
		let total = 0;
		for (const k of tree.children.get(id) ?? []) total += bandH(k, stack) + STACK_GAP;
		if (total > 0) total -= STACK_GAP;
		stack.delete(id);
		const h = Math.max(slotHeight(node), total);
		bandCache.set(id, h);
		return h;
	};

	/** Levels below `id` (0 = leaf); drives how many columns its rows occupy. */
	const levelsCache = new Map<string, number>();
	const levelsOf = (id: string, stack: Set<string> = new Set()): number => {
		const hit = levelsCache.get(id);
		if (hit !== undefined) return hit;
		if (stack.has(id)) return 0;
		stack.add(id);
		let d = 0;
		for (const k of tree.children.get(id) ?? []) d = Math.max(d, levelsOf(k, stack) + 1);
		stack.delete(id);
		levelsCache.set(id, d);
		return d;
	};

	const placed = new Map<string, { x: number; y: number }>();

	// The head straddles the spine at the far left; the spine is y = 0.
	const headH = estimateHeight(root);
	placed.set(rootId, { x: 0, y: -headH / 2 });
	const headRight = NODE_WIDTH;

	const kids = tree.children.get(rootId) ?? [];

	interface RibRow {
		id: string;
		h: number;
		levels: number;
		/** distance from the spine to the band's far/near edge */
		far: number;
		near: number;
	}
	interface Bone {
		id: string;
		dir: number; // -1 above the spine, +1 below
		h: number; // the branch box's height
		rows: RibRow[];
		stackH: number;
		v: number; // bone length: spine -> the branch box's near edge
		run: number; // the bone's horizontal run (v·TAN30)
		footX: number;
	}

	// ---- measure every bone ----
	const bones: Bone[] = kids.map((id, i) => {
		const dir = i % 2 === 0 ? -1 : 1;
		const node = byId.get(id);
		const h = node ? estimateHeight(node) : 48;
		const rows: RibRow[] = (tree.children.get(id) ?? []).map((cid) => ({
			id: cid,
			h: bandH(cid),
			levels: levelsOf(cid),
			far: 0,
			near: 0,
		}));
		const stackH =
			rows.reduce((s, r) => s + r.h, 0) + Math.max(0, rows.length - 1) * BAND_GAP;
		const v = SPINE_GAP + stackH + (rows.length ? BOX_GAP : 0);
		const run = v * TAN30;

		// Stack the rows: the FIRST child ends up FARTHEST from the spine
		// (closest to the branch box), matching ProcessOn's rendering.
		let dCursor = SPINE_GAP + stackH;
		for (const r of rows) {
			r.far = dCursor;
			r.near = dCursor - r.h;
			dCursor = r.near - BAND_GAP;
		}
		return { id, dir, h, rows, stackH, v, run, footX: 0 };
	});

	/**
	 * The rightmost anything of `bone` reaches, as an offset from its own
	 * foot: the branch box's right edge, or a rib row's outermost column.
	 */
	const footRight = (bone: Bone): number => {
		let r = bone.run + NODE_WIDTH / 2;
		for (const row of bone.rows) {
			const w = NODE_WIDTH + row.levels * (NODE_WIDTH + COL_GAP);
			r = Math.max(r, row.far * TAN30 + RIB_GAP + w);
		}
		return r;
	};

	/** The smallest foot that keeps a bone's own box clear of the head. */
	const headClearFoot = (bone: Bone): number =>
		Math.max(headRight + FIRST_GAP, headRight + HEAD_CLEAR + NODE_WIDTH / 2 - bone.run);

	// ---- pack the feet along the spine, each side independently ----
	//
	// Same-side bones are parallel 60° lines, so one conservative inequality
	// keeps every pair of them apart:
	//
	//   nextFoot + nextLeft ≥ prevFoot + footRight(prev) + SIDE_GAP
	//
	// where nextLeft is how far LEFT of its own foot the next bone reaches —
	// its box overhangs the diagonal's tip by NODE_WIDTH/2 when the bone is
	// short (childless bones lean barely right, so their box sticks out left).
	// For everything else the diagonal itself is the leftmost, hence the
	// max(0, ·) floor. Opposite-side bones never constrain each other: their
	// content lives strictly above/below the spine corridor.
	let prevUp: Bone | undefined;
	let prevDown: Bone | undefined;
	for (const bone of bones) {
		// for a down-bone, prevUp is exactly the up-bone paired with it
		const overhang = Math.max(0, NODE_WIDTH / 2 - bone.run);
		if (bone.dir < 0) {
			bone.footX = prevUp
				? prevUp.footX + footRight(prevUp) + SIDE_GAP + overhang
				: headClearFoot(bone);
			prevUp = bone;
		} else {
			bone.footX = Math.max(
				prevUp ? prevUp.footX + PAIR_GAP : 0,
				prevDown
					? prevDown.footX + footRight(prevDown) + SIDE_GAP + overhang
					: headClearFoot(bone),
			);
			prevDown = bone;
		}
	}

	// ---- place one rib subtree: `id`'s column at colX, band top at bandTop ----
	const placeRib = (id: string, colX: number, bandTop: number, stack: Set<string>): void => {
		if (stack.has(id)) return;
		const node = byId.get(id);
		if (!node) return;
		stack.add(id);
		const self = slotHeight(node);
		const band = bandH(id);
		// centre the box on its children's stack — the classic tidy tree
		placed.set(id, { x: colX, y: bandTop + (band - self) / 2 });
		let cursor = bandTop;
		for (const k of tree.children.get(id) ?? []) {
			placeRib(k, colX + NODE_WIDTH + COL_GAP, cursor, stack);
			cursor += bandH(k) + STACK_GAP;
		}
		stack.delete(id);
	};

	// ---- place the bones ----
	for (const bone of bones) {
		// the branch box at the bone's far end: its NEAR edge (bottom for
		// up-bones, top for down-bones) sits exactly at distance v, so the
		// bone's tip is that edge's centre
		const boxCx = bone.footX + bone.run;
		const boxTopY = bone.dir < 0 ? -(bone.v + bone.h) : bone.v;
		placed.set(bone.id, { x: boxCx - NODE_WIDTH / 2, y: boxTopY });

		for (const row of bone.rows) {
			// each row's column starts where the bone crosses the row's FAR
			// edge, plus RIB_GAP — so the boxes stagger along the diagonal
			const colX = bone.footX + row.far * TAN30 + RIB_GAP;
			const bandTopY = bone.dir < 0 ? -row.far : row.near;
			placeRib(row.id, colX, bandTopY, new Set());
		}
	}

	/**
	 * Detached roots (broken parent chain, or dragged off on their own) get
	 * their own tidy row below the fish instead of piling onto the head.
	 */
	placeLeftovers(nodes, tree, placed);

	return placed;
}

/**
 * Position ONLY the nodes that have no usable position yet.
 *
 * Every node that already has finite coordinates is left untouched, so adding or
 * deleting a single node never disturbs the rest of the map. This is the whole
 * point of the incremental path: a mind map is a canvas the user has arranged,
 * not a document that re-flows on every keystroke.
 *
 * A "new" node is placed next to its parent, on the side implied by the current
 * structure (and by the parent's own side in the two-sided layouts). If its
 * preferred spot is occupied, it is pushed along the sibling axis until free.
 */
function layoutIncremental(
	nodes: MindNode[],
	edges: Edge[],
	structure: StructureId,
	hiddenIds: Set<string> = new Set(),
): MindNode[] {
	const tree = buildTree(nodes, edges);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const sid = getStructure(structure);
	const vertical = sid === 'down' || sid === 'up';
	void tree;

	/** Nodes that already sit somewhere real. */
	const settled = nodes.filter(
		(n) =>
			Number.isFinite(n.position?.x) &&
			Number.isFinite(n.position?.y) &&
			// nodes hidden behind a collapsed ancestor keep their stored spot;
			// everything else is "new" when flagged `needsPlacement`
			(hiddenIds.has(n.id) || n.data?.needsPlacement !== true),
	);
	const settledIds = new Set(settled.map((n) => n.id));

	// occupied boxes, used to avoid dropping a new node on top of another.
	// This list grows as we place nodes, so several new siblings added in one go
	// also avoid each other (not just the already-settled nodes).
	const taken = settled.map((n) => ({
		x: n.position.x,
		y: n.position.y,
		w: NODE_WIDTH,
		h: estimateHeight(n),
	}));

	const overlapsTaken = (x: number, y: number, h: number): boolean =>
		taken.some(
			(b) => !(x + NODE_WIDTH <= b.x || b.x + b.w <= x || y + h <= b.y || b.y + b.h <= y),
		);

	const placed = new Map<string, { x: number; y: number }>();

	/** Distance for one step along the depth axis. */
	const depthStep = (): number => (vertical ? 96 : NODE_WIDTH + 76);

	/** Distance for one step along the sibling axis. */
	const siblingStep = (node: MindNode): number =>
		vertical ? NODE_WIDTH + 56 : estimateHeight(node) + 22;

	/**
	 * Place a single node relative to its parent, nudging along the sibling axis
	 * until it does not collide with an already-settled node.
	 */
	const placeOne = (node: MindNode): { x: number; y: number } => {
		const parentId = parentOf(edges, node.id);
		const parent = parentId ? byId.get(parentId) : undefined;
		const parentPos = parent
			? (placed.get(parent.id) ?? { x: parent.position.x, y: parent.position.y })
			: undefined;

		if (!parent || !parentPos) {
			// no parent: drop it to the right of everything, clear of the map
			const maxRight = taken.reduce((m, b) => Math.max(m, b.x + b.w), 0);
			return { x: maxRight + 60, y: 0 };
		}

		// which side does this child belong on?
		let dir: Direction = 'right';
		if (vertical) {
			dir = sid === 'down' ? 'down' : 'up';
		} else if (sid === 'both') {
			// the two-sided layout grows left/right per the node's own side;
			// the fishbone is laid out by the full pass, so here it just grows
			// right like a plain mind map
			const side = node.data?.side ?? (node.position.x < parentPos.x ? 'left' : 'right');
			dir = side === 'left' ? 'left' : 'right';
		} else if (sid === 'left') {
			dir = 'left';
		}

		const sign = dir === 'left' || dir === 'up' ? -1 : 1;
		const h = estimateHeight(node);

		// first choice: straight out from the parent along the depth axis
		let x = parentPos.x + (vertical ? 0 : sign * depthStep());
		let y = parentPos.y + (vertical ? sign * depthStep() : 0);

		// nudge along the sibling axis until the spot is free
		let guard = 0;
		while (overlapsTaken(x, y, h) && guard < 60) {
			if (vertical) x += siblingStep(node);
			else y += siblingStep(node);
			guard++;
		}

		return { x, y };
	};

	// place the missing ones; children may need their parent placed first
	const pending = nodes.filter((n) => !settledIds.has(n.id));
	const done = new Set<string>();

	let passes = 0;
	while (pending.length && passes < 10) {
		passes++;
		let progress = false;
		for (const node of pending) {
			if (done.has(node.id)) continue;
			const parentId = parentOf(edges, node.id);
			// wait until the parent has a position (or has no parent)
			if (parentId && !settledIds.has(parentId) && !placed.has(parentId)) continue;
			const pos = placeOne(node);
			placed.set(node.id, pos);
			taken.push({ x: pos.x, y: pos.y, w: NODE_WIDTH, h: estimateHeight(node) });
			done.add(node.id);
			progress = true;
		}
		if (!progress) break;
	}
	// anything still pending had a missing ancestor; place it anyway
	for (const node of pending) {
		if (done.has(node.id)) continue;
		const pos = placeOne(node);
		placed.set(node.id, pos);
		taken.push({ x: pos.x, y: pos.y, w: NODE_WIDTH, h: estimateHeight(node) });
	}

	const laidOut = nodes.map((n) => {
		const p = placed.get(n.id);
		if (!p) return n;
		// clear the "needs placement" marker once the node has a real spot
		const data = n.data?.needsPlacement
			? { ...n.data, needsPlacement: false }
			: n.data;
		return { ...n, position: p, data };
	});

	return syncTones(laidOut, edges);
}

/**
 * Ids of nodes that are hidden because an ancestor is collapsed.
 *
 * `buildTree` drops a collapsed node's children, so these nodes never get
 * visited by the layout — they would be treated as detached orphans and flung
 * into the leftovers row. Keeping their stored coordinates is what makes
 * collapse -> save -> reload -> expand restore the original arrangement.
 */
function hiddenByCollapse(nodes: MindNode[], edges: Edge[]): Set<string> {
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

/**
 * Layout the whole map using the chosen structure.
 *
 * `structure` defaults to the classic left-to-right mind map, so existing
 * documents render exactly as before.
 *
 * Options:
 *  - `keepPinned` (default true): honour nodes the user dragged to a custom spot.
 *  - `preserveExisting` (default false): keep EVERY existing node exactly where
 *    it is and only position nodes that have no usable position yet.
 *
 * `preserveExisting` is what incremental edits (add / delete one node) need:
 * recomputing the whole tree on every small change made the map visibly jump
 * around, which is the "加了/删了一个节点整张图就盘起来" complaint. With it on,
 * editing only touches the nodes that are actually new.
 */
export function layoutTree(
	nodes: MindNode[],
	edges: Edge[],
	structure: StructureId = DEFAULT_STRUCTURE,
	options: { keepPinned?: boolean; preserveExisting?: boolean } = {},
): MindNode[] {
	if (!nodes.length) return nodes;

	const keepPinned = options.keepPinned !== false;
	const preserveExisting = options.preserveExisting === true;

	/**
	 * Nodes hidden behind a collapsed ancestor keep their stored coordinates.
	 *
	 * They are invisible right now, but the user expects them back where they
	 * were when the branch is expanded again. Without this they were never
	 * visited by the layout, fell through to `placeLeftovers`, and got parked in
	 * a row far from their parent — the reported "收起后刷新再展开位置不对".
	 */
	const hiddenIds = hiddenByCollapse(nodes, edges);
	const keepHiddenPosition = (n: MindNode) =>
		hiddenIds.has(n.id) &&
		Number.isFinite(n.position?.x) &&
		Number.isFinite(n.position?.y);

	if (preserveExisting) {
		return layoutIncremental(nodes, edges, structure, hiddenIds);
	}

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
		// Nodes hidden behind a collapsed ancestor are invisible right now; keep
		// their stored spot so expanding the branch brings them back unchanged.
		if (keepHiddenPosition(n)) return n;

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
