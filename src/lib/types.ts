import type { Edge, Node } from '@xyflow/react';

/** Max images allowed per node. */
export const MAX_IMAGES = 4;

/** One uploaded picture attached to a node. */
export interface NodeImage {
	id: string;
	/** Thumbnail served by the image host (small, used on the node). */
	thumbUrl: string;
	/** Direct full-size image URL (used by the lightbox). */
	fullUrl: string;
	width?: number;
	height?: number;
}

/** Data stored on every mind-map node. */
export interface MindNodeData extends Record<string, unknown> {
	label: string;
	/** Up to MAX_IMAGES pictures, shown as a small row below the label. */
	images?: NodeImage[];
	/** @deprecated single-image fields kept only for migrating old documents. */
	image?: string;
	/** @deprecated see `image`. */
	imageShowUrl?: string;
	/** Visual emphasis for root / branch nodes. */
	tone?: 'root' | 'branch' | 'leaf';
	/** Collapsed subtree (children hidden). */
	collapsed?: boolean;
	/** Number of direct children — set by the editor, used by the collapse toggle. */
	childCount?: number;
	/** True while the label is being edited in place. */
	editing?: boolean;
	/** Number of uploads currently in flight for this node (shows a spinner). */
	uploading?: number;
	/** For two-sided structures: which half of the map this subtree lives on. */
	side?: 'left' | 'right';
	/** Manual sibling order within the parent (lower = earlier). */
	order?: number;
	/** Set while a drag hovers this node, so it can render a drop highlight. */
	dropTarget?: 'child' | 'sibling-before' | 'sibling-after' | null;
	/**
	 * Ordinal of this node's top-level branch among the root's direct children.
	 * `null` for a root itself. Rainbow themes use it to colour each branch.
	 */
	branchIndex?: number | null;
	/**
	 * True when the user has dragged this node to a custom spot.
	 *
	 * Such nodes keep their manual position instead of being snapped back by the
	 * auto-layout, so free dragging and structural snapping can coexist.
	 */
	pinned?: boolean;
	/**
	 * True when this node still needs a position from the incremental layout.
	 *
	 * Used by re-parenting: the moved node is marked, every other node keeps its
	 * place, and the layout only computes a spot for the marked ones.
	 */
	needsPlacement?: boolean;
}

export type MindNode = Node<MindNodeData, 'mind'>;

/**
 * Document kinds the app can hold.
 *
 *  - `mind`   the React Flow mind map (the original product)
 *  - `md`     a Markdown note, edited as plain Markdown source with a preview
 *  - `drawio` a draw.io diagram, edited in the official embed iframe
 *
 * The kind decides which editor the map page mounts and how import/export work.
 */
export type DocKind = 'mind' | 'md' | 'drawio';

export interface MapDoc {
	nodes: MindNode[];
	edges: Edge[];
	/** Free-form canvas metadata (viewport, theme...). */
	viewport?: { x: number; y: number; zoom: number };
	/** Theme id, see lib/themes.ts. Defaults to 'classic'. */
	theme?: string;
	/** Structure id, see lib/structures.ts. Defaults to 'balanced'. */
	structure?: string;
	/** Document kind. Absent on old documents, which are all mind maps. */
	kind?: DocKind;
	/** Markdown source, used when `kind === 'md'`. */
	markdown?: string;
	/** draw.io XML (`<mxfile>...</mxfile>`), used when `kind === 'drawio'`. */
	drawioXml?: string;
}

export const EMPTY_DOC: MapDoc = { nodes: [], edges: [] };

/** Which kind a parsed document is; old documents have no `kind`. */
export function docKind(doc: MapDoc): DocKind {
	if (doc.kind === 'md' || doc.kind === 'drawio') return doc.kind;
	return 'mind';
}

/** A fresh document of the given kind. */
export function starterDocOf(kind: DocKind, title = '未命名'): MapDoc {
	if (kind === 'md') {
		return {
			kind: 'md',
			nodes: [],
			edges: [],
			markdown: `# ${title}\n\n在这里写 Markdown。\n\n- 支持标题、列表、表格、代码块\n- 右侧可实时预览\n`,
		};
	}
	if (kind === 'drawio') {
		return {
			kind: 'drawio',
			nodes: [],
			edges: [],
			drawioXml:
				'<mxfile host="mindflow"><diagram id="p1" name="Page-1">' +
				'<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">' +
				'<root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
				'<mxCell id="2" value="开始" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">' +
				'<mxGeometry x="320" y="120" width="140" height="60" as="geometry"/></mxCell>' +
				'</root></mxGraphModel></diagram></mxfile>',
		};
	}
	// mind: a single root node
	const root: MindNode = {
		id: `n_${Math.random().toString(16).slice(2, 10)}`,
		type: 'mind',
		position: { x: 0, y: 0 },
		data: { label: title === '未命名' ? '中心主题' : title, tone: 'root', images: [] },
	};
	return { kind: 'mind', nodes: [root], edges: [] };
}

/**
 * Bring a node's data up to date: turns the legacy single-image fields into the
 * `images` array so the rest of the app only ever deals with one shape.
 */
export function normalizeNode(node: MindNode): MindNode {
	const data = node.data ?? ({} as MindNodeData);
	let images = Array.isArray(data.images) ? data.images.filter(Boolean) : [];

	// legacy: one image stored as `image` + `imageShowUrl`
	if (!images.length && data.image) {
		images = [
			{
				id: `legacy_${node.id}`,
				thumbUrl: data.image,
				fullUrl: data.imageShowUrl || data.image,
			},
		];
	}

	return {
		...node,
		data: {
			...data,
			images: images.slice(0, MAX_IMAGES),
			image: undefined,
			imageShowUrl: undefined,
			editing: false,
			uploading: 0,
			collapsed: Boolean(data.collapsed),
		},
	};
}

export function parseDoc(raw: string | undefined | null): MapDoc {
	if (!raw) return { ...EMPTY_DOC };
	try {
		const parsed = JSON.parse(raw) as Partial<MapDoc>;
		const nodes = Array.isArray(parsed.nodes) ? (parsed.nodes as MindNode[]).map(normalizeNode) : [];
		const kind: DocKind | undefined =
			parsed.kind === 'md' || parsed.kind === 'drawio' ? parsed.kind : undefined;
		return {
			kind,
			nodes,
			edges: Array.isArray(parsed.edges) ? parsed.edges : [],
			viewport: parsed.viewport,
			theme: typeof parsed.theme === 'string' ? parsed.theme : undefined,
			structure: typeof parsed.structure === 'string' ? parsed.structure : undefined,
			markdown: typeof parsed.markdown === 'string' ? parsed.markdown : undefined,
			drawioXml: typeof parsed.drawioXml === 'string' ? parsed.drawioXml : undefined,
		};
	} catch {
		return { ...EMPTY_DOC };
	}
}

export function serializeDoc(doc: MapDoc): string {
	return JSON.stringify({
		...doc,
		// drop transient UI flags before persisting
		nodes: doc.nodes.map((n) => ({
			...n,
			data: { ...n.data, editing: false, uploading: 0 },
		})),
	});
}
