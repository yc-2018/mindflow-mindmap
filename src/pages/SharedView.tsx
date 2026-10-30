import { useCallback, useEffect, useRef, useState } from 'react';
import {
	Background,
	BackgroundVariant,
	Controls,
	ReactFlow,
	ReactFlowProvider,
	type Edge,
} from '@xyflow/react';
import { House, LayoutGrid, Link2Off } from 'lucide-react';
import '@xyflow/react/dist/style.css';

import MindNodeView, { TOGGLE_COLLAPSE_EVENT } from '../components/MindNodeView';
import MindEdge from '../components/MindEdge';
import MarkdownRenderer from '../components/MarkdownRenderer';
import { api } from '../lib/api';
import { parseDoc, docKind, type MindNode, type DocKind } from '../lib/types';
import { pruneEdges, layoutTree, syncTones } from '../lib/layout';
import { getStructure, type StructureId } from '../lib/structures';
import { withAdaptiveHandles } from '../lib/handles';
import { childCounts, visibleGraph } from '../lib/visibility';
import { navigate } from '../lib/router';
import { ReadOnlyProvider, ThemeProvider } from '../lib/themeContext';
import { getTheme } from '../lib/themes';

const nodeTypes = { mind: MindNodeView };
const edgeTypes = { mind: MindEdge };

/** Recount each node's direct children, so collapse badges stay accurate. */
function syncChildCounts(nodes: MindNode[], edges: Edge[]): MindNode[] {
	const counts = childCounts(nodes, edges);
	return nodes.map((n) => ({ ...n, data: { ...n.data, childCount: counts.get(n.id) ?? 0 } }));
}

function SharedInner({ token }: { token: string }) {
	const [title, setTitle] = useState('');
	const [nodes, setNodes] = useState<MindNode[]>([]);
	const [edges, setEdges] = useState<Edge[]>([]);
	const [structure, setStructure] = useState<StructureId>('balanced');
	const [themeId, setThemeId] = useState<string>('classic');
	const [state, setState] = useState<'loading' | 'ok' | 'missing'>('loading');
	const [kind, setKind] = useState<DocKind>('mind');
	const [markdown, setMarkdown] = useState('');
	const [drawioXml, setDrawioXml] = useState('');

	/**
	 * Latest values for the collapse handler.
	 *
	 * The toggle listener is registered once (it must survive re-renders), so it
	 * cannot read the current edges/structure from a closure — it would capture
	 * the values from the first render.
	 */
	const latestEdges = useRef<Edge[]>([]);
	const latestStructure = useRef<StructureId>('balanced');

	/**
	 * Let viewers collapse/expand branches.
	 *
	 * That is the only interaction a read-only page offers: it changes what is
	 * visible, not the document. Everything else (editing, deleting, dragging) is
	 * suppressed by the readOnly context.
	 *
	 * The layout is re-run after every toggle. Expanding a branch that was
	 * collapsed when the map was saved makes the hidden nodes reappear at their
	 * stored coordinates, which can overlap the nodes that were laid out around
	 * the collapsed node — the "展开后重叠" report. Re-flowing locally (never
	 * persisted) keeps the view tidy.
	 */
	const relayoutLocal = useCallback(
		(ns: MindNode[], eds: Edge[], struct: StructureId) =>
			layoutTree(syncChildCounts(ns, eds), eds, struct, { keepPinned: false }),
		[],
	);

	useEffect(() => {
		const onToggle = (e: Event) => {
			const detail = (e as CustomEvent<{ id: string }>).detail;
			if (!detail?.id) return;
			setNodes((nds) => {
				const next = nds.map((n) =>
					n.id === detail.id ? { ...n, data: { ...n.data, collapsed: !n.data.collapsed } } : n,
				);
				return relayoutLocal(next, latestEdges.current, latestStructure.current);
			});
		};
		window.addEventListener(TOGGLE_COLLAPSE_EVENT, onToggle);
		return () => window.removeEventListener(TOGGLE_COLLAPSE_EVENT, onToggle);
	}, [relayoutLocal]);

	useEffect(() => {
		api
			.getShared(token)
			.then(({ map }) => {
				setTitle(map.title);
				const doc = parseDoc(map.data);
				const k = docKind(doc);
				setKind(k);

				/**
				 * Markdown and drawio documents render on their own; only the mind
				 * map needs the layout pipeline below.
				 */
				if (k === 'md') {
					setMarkdown(doc.markdown ?? '');
					setState('ok');
					return;
				}
				if (k === 'drawio') {
					setDrawioXml(doc.drawioXml ?? '');
					setState('ok');
					return;
				}

				const pruned = pruneEdges(doc.nodes, doc.edges);

				/**
				 * Run the SAME layout pipeline the editor uses.
				 *
				 * Rendering the stored coordinates directly made a shared map look
				 * different from what the owner sees: the editor re-runs `layoutTree`
				 * on load, so any coordinates that were saved before a later layout
				 * change no longer matched. Recomputing here guarantees the viewer
				 * sees exactly the arrangement the editor shows.
				 */
				const struct = getStructure(doc.structure);
				const toned = syncTones(doc.nodes, pruned);
				const counts = childCounts(toned, pruned);
				const withCounts = toned.map((n) => ({
					...n,
					data: { ...n.data, childCount: counts.get(n.id) ?? 0 },
				}));
				const laidOut = layoutTree(withCounts, pruned, struct);

				/**
				 * Route the connectors with the same adaptive-handle pass.
				 *
				 * Without it the edges kept whatever handles were stored, and after a
				 * layout change those pointed at the wrong side of a node — which is
				 * why shared links showed tangled, looping lines.
				 */
				setNodes(laidOut);
				setEdges(withAdaptiveHandles(laidOut, pruned, struct));
				setStructure(struct);
				setThemeId(doc.theme || 'classic');
				latestEdges.current = withAdaptiveHandles(laidOut, pruned, struct);
				latestStructure.current = struct;
				setState('ok');
			})
			.catch(() => setState('missing'));
	}, [token]);

	if (state === 'loading') {
		return (
			<div className="boot">
				<div className="spinner" />
			</div>
		);
	}

	if (state === 'missing') {
		return (
			<div className="boot">
				<div className="shared-missing">
					<div className="shared-missing__icon">
						<Link2Off size={40} strokeWidth={1.3} />
					</div>
					<h2>分享链接无效</h2>
					<p>该链接可能已被关闭或不存在。</p>
					<button className="btn-primary btn-icon-text" onClick={() => navigate('/')}>
						<House size={16} strokeWidth={1.9} />
						返回首页
					</button>
				</div>
			</div>
		);
	}

	/**
	 * Markdown document: render the source with the same renderer the editor
	 * previews with, so a shared note looks identical to the owner's preview.
	 */
	if (kind === 'md') {
		return (
			<div className="editor">
				<header className="editor__bar">
					<div className="editor__left">
						<span className="editor__title shared-title">{title}</span>
						<span className="save-state">只读分享</span>
					</div>
					<div className="editor__right">
						<button className="btn-ghost btn-icon-text" onClick={() => navigate('/')}>
							<House size={15} strokeWidth={1.9} />
							返回首页
						</button>
					</div>
				</header>
				<div className="md-editor__body md-editor__body--readonly">
					<div className="md-editor__preview md-editor__preview--full">
						<div className="md-label md-editor__rendered">
							<MarkdownRenderer source={markdown || '*（空文档）*'} />
						</div>
					</div>
				</div>
			</div>
		);
	}

	/**
	 * draw.io document: show it through the official read-only viewer, which
	 * understands the same XML we store.
	 */
	if (kind === 'drawio') {
		return (
			<div className="editor">
				<header className="editor__bar">
					<div className="editor__left">
						<span className="editor__title shared-title">{title}</span>
						<span className="save-state">只读分享</span>
					</div>
					<div className="editor__right">
						<button className="btn-ghost btn-icon-text" onClick={() => navigate('/')}>
							<House size={15} strokeWidth={1.9} />
							返回首页
						</button>
					</div>
				</header>
				<div className="drawio-editor__body">
					{/* Self-hosted viewer: `?lightbox=1` renders the diagram read-only
					    from the XML in the URL fragment, with no editor chrome. Using our
					    own copy avoids the official host's framing restrictions.
					    `/drawio/` (trailing slash) skips the 307 that `/drawio/index.html`
					    would otherwise trigger. */}
					<iframe
						className="drawio-editor__frame"
						title="draw.io viewer"
						src={`/drawio/?lightbox=1&highlight=0000ff&edit=_blank&nav=1&title=${encodeURIComponent(title)}#R${encodeURIComponent(drawioXml)}`}
					/>
				</div>
			</div>
		);
	}

	// hide collapsed subtrees, exactly like the editor does
	const visible = visibleGraph(nodes, edges);
	const shownEdges = withAdaptiveHandles(visible.nodes, visible.edges, structure);

	/**
	 * "整理布局" for viewers.
	 *
	 * Re-flows the map locally so expanding a branch never leaves overlapping
	 * nodes. Purely a view operation: nothing is written back, and a reload
	 * restores the owner's arrangement.
	 */
	const tidyLocally = () => {
		setNodes((nds) => relayoutLocal(nds, latestEdges.current, latestStructure.current));
	};

	return (
		<div className="editor">
			<header className="editor__bar">
				<div className="editor__left">
					<span className="editor__title shared-title">{title}</span>
					<span className="save-state">只读分享</span>
				</div>
				<div className="editor__right">
					<button
						className="btn-ghost btn-icon-text"
						onClick={tidyLocally}
						title="重新排列节点（只影响当前浏览，不会修改原图）"
					>
						<LayoutGrid size={15} strokeWidth={1.9} />
						整理布局
					</button>
					<button className="btn-ghost btn-icon-text" onClick={() => navigate('/')}>
						<House size={15} strokeWidth={1.9} />
						返回首页
					</button>
				</div>
			</header>
			<div className="editor__canvas">
				{/*
				  The shared view reuses the editor's node/edge components, so it must
				  provide the same contexts: the theme for colours, and readOnly so the
				  components hide editing affordances (delete buttons, in-place text
				  editing). Only the collapse/expand toggle stays usable — it just
				  changes what is visible, which a viewer is allowed to do.
				*/}
				<ThemeProvider value={getTheme(themeId)}>
					<ReadOnlyProvider value={true}>
						<ReactFlow
							<MindNode, Edge>
							nodes={visible.nodes}
							edges={shownEdges}
							nodeTypes={nodeTypes}
							edgeTypes={edgeTypes}
							fitView
							minZoom={0.15}
							maxZoom={2.5}
							proOptions={{ hideAttribution: true }}
							nodesDraggable={false}
							nodesConnectable={false}
							/* Keep nodes interactive: the collapse toggle lives inside
							   the node and must stay clickable. Selection is disabled
							   separately, so nothing else can be dragged or edited. */
							elementsSelectable={false}
						>
							<Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d8dbe6" />
							<Controls showInteractive={false} />
						</ReactFlow>
					</ReadOnlyProvider>
				</ThemeProvider>
			</div>
		</div>
	);
}

export default function SharedView({ token }: { token: string }) {
	return (
		<ReactFlowProvider>
			<SharedInner token={token} />
		</ReactFlowProvider>
	);
}
