import type { Edge } from '@xyflow/react';
import type { MapDoc, MindNode, MindNodeData, NodeImage } from './types';
import { getStructure } from './structures';
import { layoutTree } from './layout';
import { uid } from './uid';

/**
 * Import a document from JSON.
 *
 * Two formats are accepted:
 *  1. MindFlow's own export (`{ nodes, edges, theme, structure, ... }`)
 *  2. ProcessOn's export (a nested tree rooted at a `root` node with `children`)
 *
 * ProcessOn files are the common case — people want to move their existing maps
 * here — so the detector runs first on shape rather than on a filename.
 */

export interface ImportResult {
	doc: MapDoc;
	/** Which parser was used, so the UI can report it. */
	format: 'mindflow' | 'processon';
	/** Nodes dropped or fixed, surfaced as a warning. */
	warnings: string[];
}

/** ProcessOn node, only the fields we care about. */
interface ProcessOnNode {
	id?: string;
	/** Parent id ProcessOn writes on every node (the top level says "root"). */
	parent?: string;
	title?: string;
	children?: ProcessOnNode[];
	collapsed?: boolean;
	image?: { url?: string; originalUrl?: string; w?: number; h?: number };
	/** ProcessOn writes summary text here on some node types. */
	note?: string;
}

interface ProcessOnDoc {
	children?: ProcessOnNode[];
	structure?: string;
	title?: string;
	theme?: string | unknown;
}

/** Strip the markup ProcessOn leaves in titles: <br>, &nbsp;, tags. */
function cleanTitle(raw: string | undefined): string {
	if (!raw) return '';
	return (
		raw
			// ProcessOn uses <br> for line breaks; a real newline keeps the wrap
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"')
			// any other stray tag
			.replace(/<[^>]+>/g, '')
			.trim()
	);
}

/**
 * Map a ProcessOn `structure` string onto one of ours.
 *
 * ProcessOn's values (mind_free, mind_org, mind_right, ...) describe the same
 * skeletons we support, just with different names.
 */
function mapStructure(raw: string | undefined): string {
	switch ((raw || '').toLowerCase()) {
		case 'mind_org':
			return 'down';
		case 'mind_right':
			return 'right';
		case 'mind_left':
			return 'left';
		case 'mind_up':
			return 'up';
		case 'mind_fishbone':
			return 'fishbone';
		case 'mind_free':
		case 'mind_map':
		case 'mind_balanced':
		default:
			return 'balanced';
	}
}

/** Does this look like one of our own documents? */
function isMindFlowDoc(value: unknown): value is MapDoc {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.nodes) && Array.isArray(v.edges);
}

/** Does this look like a ProcessOn export? */
function isProcessOnDoc(value: unknown): value is ProcessOnDoc {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	// the tell-tale sign is a nested `children` array; `root` is usually present
	// too but some exports omit it
	return Array.isArray(v.children) && !Array.isArray(v.nodes);
}

/**
 * Turn the ProcessOn tree into nodes + edges.
 *
 * ProcessOn stores the tree as nested `children` with parent ids; we flatten it
 * to the same shape our own documents use. Positions are NOT taken from the
 * file (it has none) — the caller runs our layout afterwards.
 */
function fromProcessOn(doc: ProcessOnDoc): ImportResult {
	const warnings: string[] = [];
	const nodes: MindNode[] = [];
	const edges: Edge[] = [];

	// ids must be unique and stable; ProcessOn ids are hex-ish but may repeat
	// across files, so prefix them to avoid collisions with existing docs
	const seen = new Set<string>();
	const idOf = (raw: string | undefined): string => {
		const base = (raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'p';
		let id = `po_${base}`;
		let n = 2;
		while (seen.has(id)) id = `po_${base}_${n++}`;
		seen.add(id);
		return id;
	};

	/** One node's images, normalised to our shape. */
	const imagesOf = (src: ProcessOnNode): NodeImage[] => {
		const img = src.image;
		if (!img) return [];
		const url = img.url || img.originalUrl;
		if (!url) return [];
		return [
			{
				id: uid('img'),
				thumbUrl: url,
				fullUrl: img.originalUrl || url,
				width: typeof img.w === 'number' ? img.w : undefined,
				height: typeof img.h === 'number' ? img.h : undefined,
			},
		];
	};

	const rootId = idOf('root');

	const visit = (src: ProcessOnNode, parentId: string | null, depth: number): string => {
		const id = parentId === null ? rootId : idOf(src.id);
		const label = cleanTitle(src.title);

		const data: MindNodeData = {
			label: label || (depth === 0 ? '中心主题' : '新主题'),
			// the layout pass below recomputes tone from real depth, but setting it
			// here keeps the node readable if layout is skipped
			tone: depth === 0 ? 'root' : depth === 1 ? 'branch' : 'leaf',
			images: imagesOf(src),
			collapsed: Boolean(src.collapsed),
		};

		// position is a placeholder; layoutTree replaces it
		nodes.push({ id, type: 'mind', position: { x: 0, y: 0 }, data });

		for (const child of src.children ?? []) {
			const childId = visit(child, id, depth + 1);
			edges.push({ id: uid('e'), source: id, target: childId, type: 'mind' });
		}

		return id;
	};

	/**
	 * ProcessOn keeps the centre topic OUTSIDE the tree.
	 *
	 * `children` only holds the branches (each with `parent: "root"`); the root's
	 * own label lives in the document's `title`. Treating the first child as the
	 * root made the map open with a branch as its centre and lost one node.
	 */
	const top = doc.children ?? [];
	if (!top.length) {
		return {
			doc: { nodes: [], edges: [], structure: 'balanced', theme: 'classic' },
			format: 'processon',
			warnings: ['文件里没有找到任何节点'],
		};
	}

	// the centre topic: the document title, falling back to a placeholder
	const rootLabel = cleanTitle(doc.title) || '中心主题';
	nodes.push({
		id: rootId,
		type: 'mind',
		position: { x: 0, y: 0 },
		data: {
			label: rootLabel,
			tone: 'root',
			images: [],
			collapsed: false,
		},
	});

	// every entry in `children` is a direct branch of the root
	for (const child of top) {
		const childId = visit(child, rootId, 1);
		edges.push({ id: uid('e'), source: rootId, target: childId, type: 'mind' });
	}

	const structure = mapStructure(doc.structure);
	const laidOut = layoutTree(nodes, edges, getStructure(structure), { keepPinned: false });

	// report what we could not carry over, so the user is not surprised
	if (doc.theme) {
		warnings.push('ProcessOn 的主题配色已忽略，导入后使用 MindFlow 的主题');
	}

	return {
		doc: {
			nodes: laidOut,
			edges,
			structure,
			theme: 'classic',
		},
		format: 'processon',
		warnings,
	};
}

/** Our own format: validate lightly and hand it back. */
function fromMindFlow(doc: MapDoc): ImportResult {
	const warnings: string[] = [];
	const nodes = doc.nodes.filter((n) => n && n.id && n.data);
	if (nodes.length !== doc.nodes.length) {
		warnings.push(`忽略了 ${doc.nodes.length - nodes.length} 个不完整的节点`);
	}
	const ids = new Set(nodes.map((n) => n.id));
	const edges = doc.edges.filter((e) => e && ids.has(e.source) && ids.has(e.target));
	if (edges.length !== doc.edges.length) {
		warnings.push(`忽略了 ${doc.edges.length - edges.length} 条无效连线`);
	}

	const structure = getStructure(doc.structure);
	// re-run the layout so an imported file always lands in a sane arrangement,
	// regardless of what coordinates it shipped with
	const laidOut = layoutTree(nodes, edges, structure, { keepPinned: false });

	return {
		doc: {
			nodes: laidOut,
			edges,
			structure,
			theme: typeof doc.theme === 'string' ? doc.theme : 'classic',
		},
		format: 'mindflow',
		warnings,
	};
}

/**
 * Parse an imported JSON string.
 *
 * Throws with a user-facing message when the file cannot be understood.
 */
export function importDoc(raw: string): ImportResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('文件不是有效的 JSON');
	}

	// Some exports wrap the document in a string field (ProcessOn's clipboard
	// format does this), so unwrap once before giving up.
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw new Error('文件内容无法解析');
		}
	}

	if (isMindFlowDoc(parsed)) return fromMindFlow(parsed);
	if (isProcessOnDoc(parsed)) return fromProcessOn(parsed);

	throw new Error('无法识别的文件格式（支持 MindFlow JSON 和 ProcessOn 导出）');
}
