import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	Background,
	BackgroundVariant,
	Controls,
	MiniMap,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	addEdge,
	applyEdgeChanges,
	applyNodeChanges,
	useReactFlow,
	type Connection,
	type Edge,
	type EdgeChange,
	type NodeChange,
} from '@xyflow/react';
import {
	ChevronLeft,
	ChevronRight,
	ImagePlus,
	LayoutGrid,
	Maximize2,
	Minimize2,
	Plus,
	Redo2,
	Undo2,
	X,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';

import MindNodeView, {
	ADD_CHILD_EVENT,
	ADD_IMAGE_EVENT,
	OPEN_IMAGE_EVENT,
	REMOVE_IMAGE_EVENT,
} from '../components/MindNodeView';
import MindEdge, { EDGE_LABEL_EVENT, REMOVE_EDGE_EVENT } from '../components/MindEdge';
import { api, ApiError } from '../lib/api';
import { layoutTree, NODE_WIDTH, pruneEdges, wouldCreateCycle } from '../lib/layout';
import { MAX_IMAGES, parseDoc, serializeDoc, type MapDoc, type MindNode, type NodeImage } from '../lib/types';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';
import { uid } from '../lib/uid';
import { useHistory } from '../lib/useHistory';
import { formatBytes, prepareImage } from '../lib/image';

const nodeTypes = { mind: MindNodeView };
const edgeTypes = { mind: MindEdge };

interface EditorProps {
	mapId: string;
	readOnly?: boolean;
}

interface LightboxState {
	images: NodeImage[];
	index: number;
	alt: string;
}

function EditorInner({ mapId, readOnly = false }: EditorProps) {
	const [title, setTitle] = useState('');
	const [nodes, setNodes] = useState<MindNode[]>([]);
	const [edges, setEdges] = useState<Edge[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [lightbox, setLightbox] = useState<LightboxState | null>(null);
	const [lightboxLoaded, setLightboxLoaded] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [uploadingCount, setUploadingCount] = useState(0);

	const { fitView, getViewport, setViewport } = useReactFlow();
	const fileRef = useRef<HTMLInputElement | null>(null);
	const uploadTarget = useRef<string | null>(null);
	const saveTimer = useRef<number | null>(null);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const latest = useRef<{ title: string; nodes: MindNode[]; edges: Edge[] }>({ title: '', nodes: [], edges: [] });
	// lets the history callback trigger a save without creating a dependency cycle
	const markDirtyRef = useRef<() => void>(() => {});

	latest.current = { title, nodes, edges };

	// ---- undo / redo ----
	const history = useHistory(
		() => ({ nodes: latest.current.nodes, edges: latest.current.edges }),
		(snap) => {
			setNodes(snap.nodes);
			setEdges(snap.edges);
			markDirtyRef.current();
		},
	);

	// ---- load ----
	useEffect(() => {
		let alive = true;
		api
			.getMap(mapId)
			.then(({ map }) => {
				if (!alive) return;
				setTitle(map.title);
				const doc = parseDoc(map.data);
				setNodes(doc.nodes);
				setEdges(pruneEdges(doc.nodes, doc.edges));
				history.reset();
				requestAnimationFrame(() => {
					if (doc.viewport) setViewport(doc.viewport);
					else fitView({ padding: 0.25, duration: 300 });
				});
			})
			.catch((err) => {
				if (!alive) return;
				toast(err instanceof ApiError ? err.message : '加载失败', 'error');
				navigate('/');
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mapId, fitView, setViewport]);

	// ---- persist (debounced) ----
	const persist = useCallback(
		async (immediate = false) => {
			if (readOnly) return;
			if (saveTimer.current) window.clearTimeout(saveTimer.current);
			const run = async () => {
				const snap = latest.current;
				const doc: MapDoc = {
					nodes: snap.nodes,
					edges: snap.edges,
					viewport: getViewport(),
				};
				setSaving(true);
				try {
					await api.updateMap(mapId, { title: snap.title, data: serializeDoc(doc) });
					setDirty(false);
				} catch {
					toast('保存失败', 'error');
				} finally {
					setSaving(false);
				}
			};
			if (immediate) await run();
			else saveTimer.current = window.setTimeout(run, 900);
		},
		[mapId, readOnly, getViewport],
	);

	const markDirty = useCallback(() => {
		setDirty(true);
		persist();
	}, [persist]);
	markDirtyRef.current = markDirty;

	useEffect(() => {
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			if (dirty) e.preventDefault();
		};
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => window.removeEventListener('beforeunload', onBeforeUnload);
	}, [dirty]);

	/** Record a snapshot for undo, then mutate. */
	const withHistory = useCallback(
		(mutate: () => void) => {
			history.push({ nodes: latest.current.nodes, edges: latest.current.edges });
			mutate();
		},
		[history],
	);

	// ---- node / edge changes ----
	const onNodesChange = useCallback(
		(changes: NodeChange<MindNode>[]) => {
			// only position/remove/add changes are worth undoing; selection and
			// measurement happen constantly and would flood the stack
			const meaningful = changes.some(
				(c) => c.type === 'remove' || c.type === 'add' || (c.type === 'position' && c.dragging === false),
			);
			if (meaningful) history.push({ nodes: latest.current.nodes, edges: latest.current.edges });
			setNodes((nds) => applyNodeChanges(changes, nds));
			if (changes.some((c) => c.type !== 'select' && c.type !== 'dimensions')) markDirty();
		},
		[markDirty, history],
	);

	const onEdgesChange = useCallback(
		(changes: EdgeChange[]) => {
			if (changes.some((c) => c.type === 'remove' || c.type === 'add')) {
				history.push({ nodes: latest.current.nodes, edges: latest.current.edges });
			}
			setEdges((eds) => applyEdgeChanges(changes, eds));
			if (changes.some((c) => c.type !== 'select')) markDirty();
		},
		[markDirty, history],
	);

	/** Refuse connections that would close a cycle — the layout cannot render them. */
	const onConnect = useCallback(
		(conn: Connection) => {
			if (!conn.source || !conn.target) return;
			if (conn.source === conn.target) return;
			if (wouldCreateCycle(edges, conn.source, conn.target)) {
				toast('不能连成环', 'error');
				return;
			}
			if (edges.some((e) => e.target === conn.target)) {
				toast('该主题已有父级', 'error');
				return;
			}
			withHistory(() => {
				setEdges((eds) => addEdge({ ...conn, type: 'mind', id: uid('e') }, eds));
			});
			markDirty();
		},
		[edges, markDirty, withHistory],
	);

	// ---- add / delete ----
	const addChild = useCallback(
		(parentId?: string) => {
			if (readOnly) return;
			const selected = nodes.find((n) => n.selected && !n.data.editing);
			const parent =
				(parentId ? nodes.find((n) => n.id === parentId) : null) ??
				selected ??
				nodes.find((n) => n.data.tone === 'root') ??
				nodes[0];

			const id = uid();
			const tone = parent ? (parent.data.tone === 'root' ? 'branch' : 'leaf') : 'root';
			const newNode: MindNode = {
				id,
				type: 'mind',
				position: parent
					? { x: parent.position.x + NODE_WIDTH + 76, y: parent.position.y + 90 }
					: { x: 0, y: 0 },
				data: { label: '新主题', tone, editing: true, images: [], uploading: 0 },
				selected: true,
			};

			withHistory(() => {
				setNodes((prev) => {
					const nextNodes: MindNode[] = prev.map((n) => ({
						...n,
						selected: false,
						data: { ...n.data, editing: false },
					}));
					nextNodes.push(newNode);
					if (!parent) return nextNodes;
					const nextEdges: Edge[] = [
						...edges,
						{ id: uid('e'), source: parent.id, target: id, type: 'mind' },
					];
					setEdges(nextEdges);
					return layoutTree(nextNodes, nextEdges);
				});
			});

			markDirty();
			requestAnimationFrame(() => fitView({ padding: 0.3, duration: 260 }));
		},
		[nodes, edges, markDirty, readOnly, fitView, withHistory],
	);

	const addSibling = useCallback(() => {
		const sel = nodes.filter((n) => n.selected);
		if (sel.length !== 1) {
			addChild();
			return;
		}
		const parentEdge = edges.find((e) => e.target === sel[0].id);
		addChild(parentEdge?.source);
	}, [nodes, edges, addChild]);

	const deleteSelected = useCallback(() => {
		if (readOnly) return;
		const selectedIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
		if (!selectedIds.size) return;
		withHistory(() => {
			setNodes((nds) => nds.filter((n) => !selectedIds.has(n.id)));
			setEdges((eds) => eds.filter((e) => !selectedIds.has(e.source) && !selectedIds.has(e.target)));
		});
		markDirty();
	}, [nodes, markDirty, readOnly, withHistory]);

	const autoLayout = useCallback(() => {
		withHistory(() => setNodes((nds) => layoutTree(nds, edges)));
		markDirty();
		requestAnimationFrame(() => fitView({ padding: 0.25, duration: 300 }));
	}, [edges, markDirty, fitView, withHistory]);

	// ---- edge label + removal (fixes "connectors that cannot be deleted") ----
	useEffect(() => {
		const onRemove = (e: Event) => {
			const detail = (e as CustomEvent<{ id: string }>).detail;
			if (!detail?.id) return;
			withHistory(() => setEdges((eds) => eds.filter((edge) => edge.id !== detail.id)));
			markDirty();
			toast('已删除连线', 'success');
		};
		const onLabel = (e: Event) => {
			const detail = (e as CustomEvent<{ id: string; label: string }>).detail;
			if (!detail?.id) return;
			withHistory(() =>
				setEdges((eds) =>
					eds.map((edge) =>
						edge.id === detail.id
							? { ...edge, label: detail.label || undefined, data: { ...edge.data, label: detail.label } }
							: edge,
					),
				),
			);
			markDirty();
		};
		window.addEventListener(REMOVE_EDGE_EVENT, onRemove);
		window.addEventListener(EDGE_LABEL_EVENT, onLabel);
		return () => {
			window.removeEventListener(REMOVE_EDGE_EVENT, onRemove);
			window.removeEventListener(EDGE_LABEL_EVENT, onLabel);
		};
	}, [markDirty, withHistory]);

	// node "+" -> add child
	useEffect(() => {
		const onAdd = (e: Event) => {
			const detail = (e as CustomEvent<{ id: string }>).detail;
			if (detail?.id) addChild(detail.id);
		};
		window.addEventListener(ADD_CHILD_EVENT, onAdd);
		return () => window.removeEventListener(ADD_CHILD_EVENT, onAdd);
	}, [addChild]);

	// node "add image" button -> open the picker for that node
	useEffect(() => {
		const onAddImage = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId: string }>).detail;
			if (!detail?.nodeId || readOnly) return;
			uploadTarget.current = detail.nodeId;
			fileRef.current?.click();
		};
		window.addEventListener(ADD_IMAGE_EVENT, onAddImage);
		return () => window.removeEventListener(ADD_IMAGE_EVENT, onAddImage);
	}, [readOnly]);

	// node thumbnail delete
	useEffect(() => {
		const onRemove = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId: string; imageId: string }>).detail;
			if (!detail?.nodeId || readOnly) return;
			withHistory(() => {
				setNodes((nds) =>
					nds.map((n) =>
						n.id === detail.nodeId
							? {
									...n,
									data: {
										...n.data,
										images: (n.data.images ?? []).filter((img) => img.id !== detail.imageId),
									},
								}
							: n,
					),
				);
			});
			markDirty();
		};
		window.addEventListener(REMOVE_IMAGE_EVENT, onRemove);
		return () => window.removeEventListener(REMOVE_IMAGE_EVENT, onRemove);
	}, [markDirty, readOnly, withHistory]);

	// thumbnail click -> lightbox with the whole gallery
	useEffect(() => {
		const onOpen = (e: Event) => {
			const detail = (e as CustomEvent<LightboxState>).detail;
			if (!detail?.images?.length) return;
			setLightboxLoaded(false);
			setLightbox(detail);
		};
		window.addEventListener(OPEN_IMAGE_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_IMAGE_EVENT, onOpen);
	}, []);

	// lightbox keyboard: esc closes, arrows switch images
	useEffect(() => {
		if (!lightbox) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setLightbox(null);
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				const dir = e.key === 'ArrowRight' ? 1 : -1;
				setLightboxLoaded(false);
				setLightbox((lb) =>
					lb ? { ...lb, index: (lb.index + dir + lb.images.length) % lb.images.length } : lb,
				);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [lightbox]);

	// ---- image upload (webp + compression + per-node spinner) ----
	const onPickImage = useCallback(() => {
		const target = nodes.find((n) => n.selected);
		if (!target) {
			toast('请先选中一个主题', 'error');
			return;
		}
		if ((target.data.images?.length ?? 0) >= MAX_IMAGES) {
			toast(`每个主题最多 ${MAX_IMAGES} 张图片`, 'error');
			return;
		}
		uploadTarget.current = target.id;
		fileRef.current?.click();
	}, [nodes]);

	const onFilesChosen = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(e.target.files ?? []);
			e.target.value = '';
			if (!files.length) return;

			const nodeId = uploadTarget.current ?? nodes.find((n) => n.selected)?.id;
			uploadTarget.current = null;
			if (!nodeId) {
				toast('请先选中一个主题', 'error');
				return;
			}

			const target = latest.current.nodes.find((n) => n.id === nodeId);
			if (!target) return;

			const room = MAX_IMAGES - (target.data.images?.length ?? 0) - (target.data.uploading ?? 0);
			if (room <= 0) {
				toast(`每个主题最多 ${MAX_IMAGES} 张图片`, 'error');
				return;
			}
			const batch = files.slice(0, room);
			if (files.length > room) toast(`本次只上传 ${room} 张，已达上限`, 'info');

			// show a spinner placeholder on the node while the upload runs
			const bumpPending = (delta: number) => {
				setNodes((nds) =>
					nds.map((n) =>
						n.id === nodeId
							? { ...n, data: { ...n.data, uploading: Math.max(0, (n.data.uploading ?? 0) + delta) } }
							: n,
					),
				);
			};
			bumpPending(batch.length);
			setUploadingCount((c) => c + batch.length);

			for (const file of batch) {
				try {
					const prepared = await prepareImage(file);
					if (prepared.bytes > 10 * 1024 * 1024) {
						toast(`${file.name} 压缩后仍超过 10MB，已跳过`, 'error');
						continue;
					}
					const res = await api.uploadImage(prepared.blob, prepared.filename);
					const newImage: NodeImage = {
						id: uid('img'),
						thumbUrl: res.thumbUrl,
						fullUrl: res.fullUrl || res.thumbUrl,
						width: res.width,
						height: res.height,
					};
					setNodes((nds) =>
						nds.map((n) =>
							n.id === nodeId
								? {
										...n,
										data: {
											...n.data,
											images: [...(n.data.images ?? []), newImage].slice(0, MAX_IMAGES),
										},
									}
								: n,
						),
					);
					markDirty();
					if (prepared.compressed) {
						toast(`已压缩并转为 WebP（${formatBytes(prepared.bytes)}）`, 'success');
					}
				} catch (err) {
					toast(err instanceof ApiError ? err.message : '上传失败', 'error');
				} finally {
					bumpPending(-1);
					setUploadingCount((c) => Math.max(0, c - 1));
				}
			}
		},
		[nodes, markDirty],
	);

	// ---- fullscreen ----
	const toggleFullscreen = useCallback(async () => {
		const el = shellRef.current;
		if (!el) return;
		try {
			if (!document.fullscreenElement) {
				await el.requestFullscreen();
				setFullscreen(true);
			} else {
				await document.exitFullscreen();
				setFullscreen(false);
			}
		} catch {
			// requestFullscreen can be blocked; fall back to a CSS-only mode
			setFullscreen((v) => !v);
		}
	}, []);

	useEffect(() => {
		const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
		document.addEventListener('fullscreenchange', onChange);
		return () => document.removeEventListener('fullscreenchange', onChange);
	}, []);

	// ---- keyboard ----
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement | null;
			const typing =
				el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

			// undo/redo work even while typing, so the textarea keeps its own history
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
				e.preventDefault();
				history.undo();
				return;
			}
			if (
				(e.ctrlKey || e.metaKey) &&
				(e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) &&
				!typing
			) {
				e.preventDefault();
				history.redo();
				return;
			}

			if (typing || readOnly) return;

			if (e.key === 'Tab') {
				e.preventDefault();
				addChild();
			} else if (e.key === 'Enter') {
				e.preventDefault();
				addSibling();
			} else if (e.key === 'Delete' || e.key === 'Backspace') {
				e.preventDefault();
				deleteSelected();
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				void persist(true);
				toast('已保存', 'success');
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [addChild, addSibling, deleteSelected, persist, readOnly, history]);

	// ---- double-click a node -> edit in place ----
	const onNodeDoubleClick = useCallback(
		(_event: React.MouseEvent, node: MindNode) => {
			if (readOnly) return;
			setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, editing: n.id === node.id } })));
		},
		[readOnly],
	);

	// ---- double-click a connector -> edit its label in place ----
	const onEdgeDoubleClick = useCallback(
		(_event: React.MouseEvent, edge: Edge) => {
			if (readOnly) return;
			setEdges((eds) => eds.map((e) => (e.id === edge.id ? { ...e, data: { ...e.data, editing: true } } : e)));
			// make sure no node swallows the interaction
			setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, editing: false } })));
		},
		[readOnly],
	);

	const stats = useMemo(() => ({ nodes: nodes.length, edges: edges.length }), [nodes, edges]);
	const selectedNode = nodes.find((n) => n.selected) ?? null;
	const current = lightbox ? lightbox.images[lightbox.index] : null;

	if (loading) {
		return (
			<div className="editor-loading">
				<div className="spinner" />
				<span>加载导图…</span>
			</div>
		);
	}

	return (
		<div className={`editor${fullscreen ? ' is-fullscreen' : ''}`} ref={shellRef}>
			<header className="editor__bar">
				<div className="editor__left">
					<button className="icon-btn" onClick={() => navigate('/')} title="返回列表">
						<ChevronLeft size={18} strokeWidth={2} />
					</button>

					<div className="editor__history">
						<button
							className="icon-btn"
							onClick={() => history.undo()}
							disabled={!history.canUndo || readOnly}
							title="撤销 (Ctrl+Z)"
						>
							<Undo2 size={16} strokeWidth={2} />
						</button>
						<button
							className="icon-btn"
							onClick={() => history.redo()}
							disabled={!history.canRedo || readOnly}
							title="重做 (Ctrl+Y)"
						>
							<Redo2 size={16} strokeWidth={2} />
						</button>
					</div>

					<div className="editor__divider" />

					<input
						className="editor__title"
						value={title}
						onChange={(e) => {
							setTitle(e.target.value);
							markDirty();
						}}
						placeholder="未命名导图"
					/>
					<span className={`save-state${saving ? ' is-saving' : dirty ? ' is-dirty' : ''}`}>
						{saving ? '保存中…' : dirty ? '未保存' : '已保存'}
					</span>
				</div>

				<div className="editor__right">
					{uploadingCount > 0 ? (
						<span className="editor__uploading">
							<span className="spin-ring" />
							上传中 {uploadingCount}
						</span>
					) : null}
					<button className="btn-ghost btn-icon-text" onClick={autoLayout} title="重新排列节点">
						<LayoutGrid size={15} strokeWidth={1.9} />
						整理布局
					</button>
					<button
						className="btn-ghost btn-icon-text"
						onClick={onPickImage}
						disabled={readOnly}
						title={`插入图片（每个主题最多 ${MAX_IMAGES} 张）`}
					>
						<ImagePlus size={15} strokeWidth={1.9} />
						插入图片
					</button>
					<button className="btn-ghost btn-icon-text" onClick={() => addChild()} disabled={readOnly}>
						<Plus size={15} strokeWidth={2.2} />
						子主题
					</button>
					<button
						className="icon-btn"
						onClick={toggleFullscreen}
						title={fullscreen ? '退出全屏' : '全屏'}
					>
						{fullscreen ? <Minimize2 size={16} strokeWidth={2} /> : <Maximize2 size={16} strokeWidth={2} />}
					</button>
				</div>
			</header>

			<div className="editor__canvas">
				<ReactFlow<MindNode, Edge>
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					onNodeDoubleClick={onNodeDoubleClick}
					onEdgeDoubleClick={onEdgeDoubleClick}
					fitView
					minZoom={0.15}
					maxZoom={2.5}
					proOptions={{ hideAttribution: true }}
					nodesDraggable={!readOnly}
					nodesConnectable={!readOnly}
					elementsSelectable
					defaultEdgeOptions={{ type: 'mind' }}
					connectionLineStyle={{ stroke: '#a5b4fc', strokeWidth: 2 }}
					selectNodesOnDrag={false}
				>
					<Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d8dbe6" />
					<Controls showInteractive={false} position="bottom-right" />
					<MiniMap
						pannable
						zoomable
						position="top-right"
						nodeColor={() => '#c7d2fe'}
						maskColor="rgba(255,255,255,0.72)"
						style={{ width: 150, height: 100 }}
					/>
					{/* tip bar sits above the controls, never underneath them */}
					<Panel position="bottom-left" className="editor__stats">
						<span>
							{stats.nodes} 个主题 · {stats.edges} 条连接
						</span>
						<span className="editor__tips">Tab 子主题 · Enter 同级 · Del 删除 · 双击改名/连线文字</span>
					</Panel>
				</ReactFlow>
			</div>

			{lightbox && current ? (
				<div className="lightbox" onClick={() => setLightbox(null)}>
					<button className="lightbox__close" onClick={() => setLightbox(null)} title="关闭 (Esc)">
						<X size={20} strokeWidth={2} />
					</button>

					{lightbox.images.length > 1 ? (
						<>
							<button
								className="lightbox__nav lightbox__nav--prev"
								title="上一张 (←)"
								onClick={(e) => {
									e.stopPropagation();
									setLightboxLoaded(false);
									setLightbox((lb) =>
										lb
											? {
													...lb,
													index: (lb.index - 1 + lb.images.length) % lb.images.length,
												}
											: lb,
									);
								}}
							>
								<ChevronLeft size={24} strokeWidth={2} />
							</button>
							<button
								className="lightbox__nav lightbox__nav--next"
								title="下一张 (→)"
								onClick={(e) => {
									e.stopPropagation();
									setLightboxLoaded(false);
									setLightbox((lb) =>
										lb ? { ...lb, index: (lb.index + 1) % lb.images.length } : lb,
									);
								}}
							>
								<ChevronRight size={24} strokeWidth={2} />
							</button>
							<div className="lightbox__counter">
								{lightbox.index + 1} / {lightbox.images.length}
							</div>
						</>
					) : null}

					{!lightboxLoaded ? (
						<div className="lightbox__loading">
							<div className="spinner" />
							<span>加载原图…</span>
						</div>
					) : null}

					<img
						src={current.fullUrl}
						alt={lightbox.alt}
						className={lightboxLoaded ? 'is-loaded' : 'is-loading'}
						onLoad={() => setLightboxLoaded(true)}
						onError={() => setLightboxLoaded(true)}
						onClick={(e) => e.stopPropagation()}
					/>
				</div>
			) : null}

			<input
				ref={fileRef}
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={onFilesChosen}
			/>
		</div>
	);
}

export default function Editor(props: EditorProps) {
	return (
		<ReactFlowProvider>
			<EditorInner {...props} />
		</ReactFlowProvider>
	);
}
