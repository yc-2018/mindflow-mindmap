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
}

export type MindNode = Node<MindNodeData, 'mind'>;

export interface MapDoc {
	nodes: MindNode[];
	edges: Edge[];
	/** Free-form canvas metadata (viewport, theme...). */
	viewport?: { x: number; y: number; zoom: number };
	/** Theme id, see lib/themes.ts. Defaults to 'classic'. */
	theme?: string;
}

export const EMPTY_DOC: MapDoc = { nodes: [], edges: [] };

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
		return {
			nodes,
			edges: Array.isArray(parsed.edges) ? parsed.edges : [],
			viewport: parsed.viewport,
			theme: typeof parsed.theme === 'string' ? parsed.theme : undefined,
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
