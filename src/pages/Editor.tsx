import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	Background,
	BackgroundVariant,
	Controls,
	MiniMap,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	SelectionMode,
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
	ChevronsDownUp,
	ImagePlus,
	LayoutGrid,
	Maximize2,
	Minimize2,
	Plus,
	Redo2,
	Trash2,
	Undo2,
	X,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';

import MindNodeView, {
	ADD_CHILD_EVENT,
	ADD_IMAGE_EVENT,
	LABEL_COMMIT_EVENT,
	OPEN_IMAGE_EVENT,
	REMOVE_IMAGE_EVENT,
	TOGGLE_COLLAPSE_EVENT,
} from '../components/MindNodeView';
import MindEdge, { EDGE_LABEL_EVENT, REMOVE_EDGE_EVENT } from '../components/MindEdge';
import ThemePicker from '../components/ThemePicker';
import StructurePicker from '../components/StructurePicker';
import { api, ApiError } from '../lib/api';
import {
	childrenOf,
	layoutTree,
	NODE_WIDTH,
	parentOf,
	pruneEdges,
	wouldCreateCycle,
} from '../lib/layout';
import { handlesFor, withAdaptiveHandles } from '../lib/handles';
import { childCounts, visibleGraph } from '../lib/visibility';
import { applySiblingOrder, distanceToBox, insideBox, reparentEdges, resolveDropMode, shouldDetach } from '../lib/reparent';
import {
	DEFAULT_STRUCTURE,
	directionFor,
	getStructure,
	type StructureId,
} from '../lib/structures';
import { MAX_IMAGES, parseDoc, serializeDoc, type MapDoc, type MindNode, type NodeImage } from '../lib/types';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';
import { uid } from '../lib/uid';
import { useHistory } from '../lib/useHistory';
import { formatBytes, prepareImage } from '../lib/image';
import { getTheme } from '../lib/themes';
import { ThemeProvider } from '../lib/themeContext';

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

/** Which node the pointer is over during a drag, plus where inside it. */
interface DropHint {
	id: string;
	mode: 'child' | 'sibling-before' | 'sibling-after' | 'detach';
}

function EditorInner({ mapId, readOnly = false }: EditorProps) {
	const [title, setTitle] = useState('');
	const [nodes, setNodes] = useState<MindNode[]>([]);
	const [edges, setEdges] = useState<Edge[]>([]);
	const [themeId, setThemeId] = useState<string>('classic');
	const [structure, setStructure] = useState<StructureId>(DEFAULT_STRUCTURE);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [lightbox, setLightbox] = useState<LightboxState | null>(null);
	const [lightboxLoaded, setLightboxLoaded] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [uploadingCount, setUploadingCount] = useState(0);
	const [dropHint, setDropHint] = useState<DropHint | null>(null);
	/**
	 * Mirror of `dropHint` kept in a ref.
	 *
	 * `onNodeDragStop` must read the *final* hover target synchronously: React
	 * may not have committed the last `setDropHint` from `onNodeDrag` by the time
	 * the drop fires, and reading the state variable then yields a stale value.
	 */
	const dropHintRef = useRef<DropHint | null>(null);
	/** Screen->flow box of the dragged node at drag start, used by the detach test. */
	const dragOriginBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

	const { fitView, getViewport, setViewport, screenToFlowPosition } = useReactFlow();
	const fileRef = useRef<HTMLInputElement | null>(null);
	const uploadTarget = useRef<string | null>(null);
	const saveTimer = useRef<number | null>(null);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const dragOrigin = useRef<{ nodes: MindNode[]; edges: Edge[] } | null>(null);
	const latest = useRef<{
		title: string;
		nodes: MindNode[];
		edges: Edge[];
		themeId: string;
		structure: StructureId;
	}>({ title: '', nodes: [], edges: [], themeId: 'classic', structure: DEFAULT_STRUCTURE });
	const markDirtyRef = useRef<() => void>(() => {});

	latest.current = { title, nodes, edges, themeId, structure };

	const theme = getTheme(themeId);

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
				const counts = childCounts(doc.nodes, doc.edges);
				const withCounts = doc.nodes.map((n) => ({
					...n,
					data: { ...n.data, childCount: counts.get(n.id) ?? 0 },
				}));
				setNodes(withCounts);
				setEdges(pruneEdges(withCounts, doc.edges));
				setThemeId(doc.theme || 'classic');
				setStructure(getStructure(doc.structure));
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
					theme: snap.themeId,
					structure: snap.structure,
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

	/**
	 * Recompute per-node child counts after the edge list changes. The node view
	 * uses this to decide between the "+" and "−" toggle.
	 */
	const syncChildCounts = useCallback((nds: MindNode[], eds: Edge[]): MindNode[] => {
		const counts = childCounts(nds, eds);
		return nds.map((n) => ({ ...n, data: { ...n.data, childCount: counts.get(n.id) ?? 0 } }));
	}, []);

	/** Re-run the chosen structure's layout over the whole tree. */
	const relayout = useCallback(
		(nds: MindNode[], eds: Edge[], sid: StructureId): MindNode[] =>
			layoutTree(syncChildCounts(nds, eds), eds, sid),
		[syncChildCounts],
	);

	// ---- node / edge changes ----
	const onNodesChange = useCallback(
		(changes: NodeChange<MindNode>[]) => {
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
			setEdges((eds) => {
				const next = applyEdgeChanges(changes, eds);
				setNodes((nds) => syncChildCounts(nds, next));
				return next;
			});
			if (changes.some((c) => c.type !== 'select')) markDirty();
		},
		[markDirty, history, syncChildCounts],
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
				const handles = handlesFor(nodes, conn.source!, conn.target!, structure);
				const next = addEdge({ ...conn, ...handles, type: 'mind', id: uid('e') }, edges);
				setEdges(next);
				setNodes((nds) => relayout(nds, next, structure));
			});
			markDirty();
		},
		[nodes, edges, markDirty, withHistory, structure, relayout],
	);

	// ---- drag to reparent / reorder ----
	const onNodeDragStart = useCallback(
		(_event: MouseEvent | TouchEvent, node: MindNode) => {
			dragOrigin.current = {
				// clone so later state updates can never mutate the snapshot
				nodes: latest.current.nodes.map((n) => ({ ...n, data: { ...n.data } })),
				edges: latest.current.edges.map((e) => ({ ...e })),
			};
			// remember where the node sat, so "drag out of the map" can be judged
			// against the space it actually occupied
			const el = document.querySelector<HTMLElement>(`.mind-node[data-node-id="${node.id}"]`);
			if (el) {
				const r = el.getBoundingClientRect();
				const tl = screenToFlowPosition({ x: r.left, y: r.top });
				const br = screenToFlowPosition({ x: r.right, y: r.bottom });
				dragOriginBoxRef.current = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
			} else {
				dragOriginBoxRef.current = null;
			}
			setDropHint(null);
			dropHintRef.current = null;
		},
		[screenToFlowPosition],
	);

	/**
	 * While dragging, work out what dropping here would mean and highlight it.
	 *
	 * ProcessOn-style behaviour:
	 *  - near a node -> snap to it (child / before / after), with a visual hint
	 *  - far from every node -> nothing happens (the node just goes back)
	 *  - clearly in empty space (beyond DETACH_MARGIN) -> detach
	 *
	 * The old code detached on *any* drop that missed a node, which is why a
	 * casual nudge broke the tree.
	 */
	const onNodeDrag = useCallback(
		(event: MouseEvent | TouchEvent, dragged: MindNode) => {
			const sid = latest.current.structure;
			const vertical = sid === 'down' || sid === 'up';
			const point =
				'touches' in event
					? { x: event.touches[0]?.clientX ?? 0, y: event.touches[0]?.clientY ?? 0 }
					: { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
			const pointer = screenToFlowPosition(point);

			// Measure the real DOM boxes so tall nodes (images, wrapped text) are
			// hit-tested correctly.
			//
			// We keep TWO lists:
			//  - `targets` excludes the dragged node (it follows the pointer, so it
			//    would always win the hit-test)
			//  - `allBoxes` includes it at its ORIGINAL spot, so the "did the user
			//    drag out of the map?" test still sees the space the node came from
			const targets: { id: string; x: number; y: number; w: number; h: number }[] = [];
			const allBoxes: { x: number; y: number; w: number; h: number }[] = [];
			const originBox = dragOriginBoxRef.current;

			for (const el of document.querySelectorAll<HTMLElement>('.mind-node[data-node-id]')) {
				const id = el.dataset.nodeId;
				if (!id) continue;
				const r = el.getBoundingClientRect();
				const tl = screenToFlowPosition({ x: r.left, y: r.top });
				const br = screenToFlowPosition({ x: r.right, y: r.bottom });
				const box = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };

				if (id === dragged.id) {
					// use where it started, not where the pointer dragged it
					if (originBox) allBoxes.push(originBox);
					continue;
				}
				targets.push({ id, ...box });
				allBoxes.push(box);
			}

			// nearest target within the snapping margin wins
			let hit: DropHint | null = null;
			let nearest = Infinity;
			for (const b of targets) {
				if (!insideBox(pointer, b)) continue;
				const d = distanceToBox(pointer, b);
				if (d >= nearest) continue;
				nearest = d;
				const rel = vertical ? (pointer.x - b.x) / b.w : (pointer.y - b.y) / b.h;
				hit = { id: b.id, mode: resolveDropMode(rel) as DropHint['mode'] };
			}

			// no snap target: only offer "detach" when the pointer has left the whole
			// map area (including where the dragged node started)
			const canDetach = !hit && shouldDetach(pointer, allBoxes);
			const next: DropHint | null = hit ?? (canDetach ? { id: '', mode: 'detach' } : null);

			dropHintRef.current = next;
			setDropHint(next);
		},
		[screenToFlowPosition],
	);

	const onNodeDragStop = useCallback(
		(_event: MouseEvent | TouchEvent, dragged: MindNode) => {
			const origin = dragOrigin.current;
			dragOrigin.current = null;
			// read the ref, not the state: the last drag move may not be committed yet
			const hint = dropHintRef.current;
			dropHintRef.current = null;
			setDropHint(null);

			if (!origin || readOnly) return;

			// A drop with no snap target and no detach intent is a no-op: the node
			// returns to its laid-out position. This is the "随便动一下不脱落" rule.
			if (!hint) {
				setNodes((nds) => relayout(nds, origin.edges, structure));
				return;
			}

			// NOTE: DropHint uses `id`; reparentEdges expects `hoveredId` — map it.
			const target =
				hint.mode === 'detach'
					? { mode: 'detach' as const, hoveredId: undefined }
					: { mode: hint.mode, hoveredId: hint.id };

			const result = reparentEdges(origin.edges, dragged.id, target);
			if (!result) {
				setNodes((nds) => relayout(nds, origin.edges, structure));
				return;
			}

			history.push(origin);
			const nextEdges = result.edges;
			setEdges(nextEdges);
			setNodes((nds) => {
				const ordered = applySiblingOrder(nds, nextEdges);
				return relayout(ordered, nextEdges, structure);
			});
			markDirty();

			if (target.mode === 'detach') toast('已脱离为独立分支', 'success');
			else if (target.mode === 'child') toast('已改为子主题', 'success');
			else toast('已调整同级顺序', 'success');
		},
		[readOnly, structure, relayout, markDirty, history],
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
				data: { label: '新主题', tone, editing: true, images: [], uploading: 0, childCount: 0 },
				selected: true,
			};

			withHistory(() => {
				setNodes((prev) => {
					const nextNodes: MindNode[] = prev.map((n) => ({
						...n,
						selected: false,
						data: { ...n.data, editing: false, collapsed: n.id === parent?.id ? false : n.data.collapsed },
					}));
					nextNodes.push(newNode);
					if (!parent) return nextNodes;
					const nextEdges: Edge[] = [
						...edges,
						{ id: uid('e'), source: parent.id, target: id, type: 'mind' },
					];
					setEdges(nextEdges);
					return relayout(nextNodes, nextEdges, structure);
				});
			});

			markDirty();
			requestAnimationFrame(() => fitView({ padding: 0.3, duration: 260 }));
		},
		[nodes, edges, markDirty, readOnly, fitView, withHistory, structure, relayout],
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
			setEdges((eds) => {
				const next = eds.filter((e) => !selectedIds.has(e.source) && !selectedIds.has(e.target));
				setNodes((nds) => syncChildCounts(nds, next));
				return next;
			});
		});
		markDirty();
	}, [nodes, markDirty, readOnly, withHistory, syncChildCounts]);

	const autoLayout = useCallback(() => {
		withHistory(() => setNodes((nds) => relayout(nds, edges, structure)));
		markDirty();
		requestAnimationFrame(() => fitView({ padding: 0.25, duration: 300 }));
	}, [edges, markDirty, fitView, withHistory, structure, relayout]);

	// ---- structure switch ----
	const changeStructure = useCallback(
		(sid: StructureId) => {
			setStructure(sid);
			// two-sided layouts need a side flag on each child of the root
			setNodes((nds) => {
				let next = nds;
				if (sid === 'both' || sid === 'fishbone') {
					const root = next.find((n) => n.data.tone === 'root');
					if (root) {
						const kids = childrenOf(edges, root.id);
						const sideOf = new Map<string, 'left' | 'right'>();
						kids.forEach((id, i) => sideOf.set(id, i % 2 === 0 ? 'right' : 'left'));
						// propagate the side down each subtree
						const paint = (id: string, side: 'left' | 'right') => {
							sideOf.set(id, side);
							for (const c of childrenOf(edges, id)) paint(c, side);
						};
						kids.forEach((id) => paint(id, sideOf.get(id)!));
						next = next.map((n) =>
							sideOf.has(n.id) ? { ...n, data: { ...n.data, side: sideOf.get(n.id) } } : n,
						);
					}
				}
				return layoutTree(next, edges, sid);
			});
			markDirty();
			requestAnimationFrame(() => fitView({ padding: 0.28, duration: 320 }));
		},
		[edges, markDirty, fitView],
	);

	// ---- collapse / expand ----
	const toggleCollapse = useCallback(
		(id: string) => {
			if (readOnly) return;
			withHistory(() => {
				setNodes((nds) => {
					const next = nds.map((n) =>
						n.id === id ? { ...n, data: { ...n.data, collapsed: !n.data.collapsed } } : n,
					);
					return layoutTree(next, edges, structure);
				});
			});
			markDirty();
		},
		[edges, markDirty, readOnly, withHistory, structure],
	);

	const collapseAll = useCallback(() => {
		if (readOnly) return;
		withHistory(() => {
			setNodes((nds) => {
				const counts = childCounts(nds, edges);
				const next = nds.map((n) => ({
					...n,
					data: { ...n.data, collapsed: (counts.get(n.id) ?? 0) > 0 && n.data.tone !== 'root' },
				}));
				return layoutTree(next, edges, structure);
			});
		});
		markDirty();
		requestAnimationFrame(() => fitView({ padding: 0.3, duration: 300 }));
	}, [edges, markDirty, readOnly, withHistory, structure, fitView]);

	const expandAll = useCallback(() => {
		if (readOnly) return;
		withHistory(() => {
			setNodes((nds) =>
				layoutTree(
					nds.map((n) => ({ ...n, data: { ...n.data, collapsed: false } })),
					edges,
					structure,
				),
			);
		});
		markDirty();
		requestAnimationFrame(() => fitView({ padding: 0.25, duration: 300 }));
	}, [edges, markDirty, readOnly, withHistory, structure, fitView]);

	useEffect(() => {
		const onToggle = (e: Event) => {
			const detail = (e as CustomEvent<{ id: string }>).detail;
			if (detail?.id) toggleCollapse(detail.id);
		};
		window.addEventListener(TOGGLE_COLLAPSE_EVENT, onToggle);
		return () => window.removeEventListener(TOGGLE_COLLAPSE_EVENT, onToggle);
	}, [toggleCollapse]);

	// relayout after a label change, since text height drives the tree spacing
	useEffect(() => {
		const onCommit = () => {
			setNodes((nds) => layoutTree(nds, latest.current.edges, latest.current.structure));
		};
		window.addEventListener(LABEL_COMMIT_EVENT, onCommit);
		return () => window.removeEventListener(LABEL_COMMIT_EVENT, onCommit);
	}, []);

	// ---- edge label + removal ----
	useEffect(() => {
		const onRemove = (e: Event) => {
			const detail = (e as CustomEvent<{ id: string }>).detail;
			if (!detail?.id) return;
			withHistory(() => {
				setEdges((eds) => {
					const next = eds.filter((edge) => edge.id !== detail.id);
					setNodes((nds) => relayout(nds, next, latest.current.structure));
					return next;
				});
			});
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
	}, [markDirty, withHistory, relayout]);

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

	// ---- image upload ----
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
			setFullscreen((v) => !v);
		}
	}, []);

	useEffect(() => {
		const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
		document.addEventListener('fullscreenchange', onChange);
		return () => document.removeEventListener('fullscreenchange', onChange);
	}, []);

	// ---- theme ----
	const changeTheme = useCallback(
		(id: string) => {
			setThemeId(id);
			markDirty();
		},
		[markDirty],
	);

	// ---- keyboard ----
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement | null;
			const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

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
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !typing) {
				e.preventDefault();
				setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
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
			} else if (e.key === 'Escape') {
				setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
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
			setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, editing: false } })));
		},
		[readOnly],
	);

	// hide collapsed subtrees, and render with adaptive handles so the very first
	// paint is already routed correctly (before the sync effect runs)
	const view = useMemo(() => {
		const visible = visibleGraph(nodes, edges);
		const routed = withAdaptiveHandles(visible.nodes, visible.edges, structure);
		// mark the node the pointer is hovering so it can show a drop highlight
		const hoveredId = dropHint && dropHint.mode !== 'detach' ? dropHint.id : null;
		// 'detach' has no target node, so the highlight type excludes it
		const dropMode: 'child' | 'sibling-before' | 'sibling-after' | null =
			dropHint && dropHint.mode !== 'detach' ? dropHint.mode : null;
		const marked = hoveredId
			? visible.nodes.map((n) =>
					n.id === hoveredId
						? { ...n, data: { ...n.data, dropTarget: dropMode } }
						: { ...n, data: { ...n.data, dropTarget: null } },
				)
			: visible.nodes.some((n) => n.data.dropTarget)
				? visible.nodes.map((n) => ({ ...n, data: { ...n.data, dropTarget: null } }))
				: visible.nodes;
		return { ...visible, nodes: marked, edges: routed };
	}, [nodes, edges, structure, dropHint]);

	const stats = useMemo(() => ({ nodes: nodes.length, edges: edges.length }), [nodes, edges]);
	const selectedNodes = nodes.filter((n) => n.selected);
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
		<ThemeProvider value={theme}>
			<div
				className={`editor is-selecting${fullscreen ? ' is-fullscreen' : ''}${
					theme.id === 'dark' ? ' is-dark' : ''
				}`}
				ref={shellRef}
				style={{ background: theme.canvas }}
			>
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

						<StructurePicker value={structure} onChange={changeStructure} />
						<ThemePicker value={themeId} onChange={changeTheme} />

						<button className="btn-ghost btn-icon-text" onClick={autoLayout} title="重新排列节点">
							<LayoutGrid size={15} strokeWidth={1.9} />
							整理布局
						</button>

						<button
							className="btn-ghost btn-icon-text"
							onClick={collapseAll}
							title="折叠所有分支，只看主干"
							disabled={readOnly}
						>
							<ChevronsDownUp size={15} strokeWidth={1.9} />
							全部折叠
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
							{fullscreen ? (
								<Minimize2 size={16} strokeWidth={2} />
							) : (
								<Maximize2 size={16} strokeWidth={2} />
							)}
						</button>
					</div>
				</header>

				<div className="editor__canvas" style={{ background: theme.canvas }}>
					<ReactFlow<MindNode, Edge>
						nodes={view.nodes}
						edges={view.edges}
						nodeTypes={nodeTypes}
						edgeTypes={edgeTypes}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						onConnect={onConnect}
						onNodeDoubleClick={onNodeDoubleClick}
						onEdgeDoubleClick={onEdgeDoubleClick}
						onNodeDragStart={onNodeDragStart}
						onNodeDrag={onNodeDrag}
						onNodeDragStop={onNodeDragStop}
						fitView
						minZoom={0.15}
						maxZoom={2.5}
						proOptions={{ hideAttribution: true }}
						nodesDraggable={!readOnly}
						nodesConnectable={false}
						elementsSelectable
						/* Box-select is always on, like ProcessOn: dragging on empty
						   canvas draws a selection rectangle. Pan with the middle/right
						   button or Space+drag. */
						selectionOnDrag
						panOnDrag={[1, 2]}
						panOnScroll={false}
						selectionMode={SelectionMode.Partial}
						multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
						selectionKeyCode={null}
						deleteKeyCode={null}
						defaultEdgeOptions={{ type: 'mind' }}
						connectionLineStyle={{ stroke: theme.accent, strokeWidth: 2 }}
						selectNodesOnDrag={false}
					>
						<Background variant={BackgroundVariant.Dots} gap={22} size={1} color={theme.grid} />
						<Controls showInteractive={false} position="bottom-right" />
						<MiniMap
							pannable
							zoomable
							position="top-right"
							nodeColor={() => theme.branch.border}
							maskColor={theme.canvas}
							style={{
								width: 150,
								height: 100,
								background: theme.canvas,
								borderColor: theme.leaf.border,
							}}
						/>
						<Panel position="bottom-left" className="editor__stats">
							<span>
								{stats.nodes} 个主题 · {stats.edges} 条连接
								{view.hidden.size ? ` · ${view.hidden.size} 个已折叠` : ''}
								{selectedNodes.length > 1 ? ` · 已选 ${selectedNodes.length}` : ''}
							</span>
							<span className="editor__tips">
								Tab 子主题 · Enter 同级 · 拖拽改结构 · 框选多选 · 双击改名
							</span>
						</Panel>
					</ReactFlow>

					{/* floating action bar when several nodes are selected */}
					{selectedNodes.length > 1 ? (
						<div className="multi-bar">
							<span className="multi-bar__count">{selectedNodes.length} 个主题</span>
							<button
								className="btn-ghost btn-icon-text danger"
								onClick={() => deleteSelected()}
								title="删除选中的主题（Del）"
							>
								<Trash2 size={14} strokeWidth={2} />
								删除
							</button>
							<button
								className="btn-ghost btn-icon-text"
								onClick={() => setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))}
							>
								取消选择
							</button>
						</div>
					) : null}

					{/* drop indicator while dragging a node near another */}
					{dropHint ? (
						<div className={`drop-hint drop-hint--${dropHint.mode}`}>
							{dropHint.mode === 'child'
								? '松手成为子主题'
								: dropHint.mode === 'sibling-before'
									? '松手插入到此主题之前'
									: dropHint.mode === 'sibling-after'
										? '松手插入到此主题之后'
										: '松手脱离为独立分支'}
						</div>
					) : null}
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

				<input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFilesChosen} />
			</div>
		</ThemeProvider>
	);
}

export default function Editor(props: EditorProps) {
	return (
		<ReactFlowProvider>
			<EditorInner {...props} />
		</ReactFlowProvider>
	);
}
