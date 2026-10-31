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
	ChevronsUpDown,
	Copy,
	CornerDownRight,
	ImagePlus,
	LayoutGrid,
	Link2,
	Maximize2,
	Minimize2,
	Plus,
	Redo2,
	RefreshCw,
	Share2,
	Trash2,
	TriangleAlert,
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
import MindLogo from '../components/MindLogo';
import ThemePicker from '../components/ThemePicker';
import StructurePicker from '../components/StructurePicker';
import { api, ApiError } from '../lib/api';
import {
	childrenOf,
	layoutTree,
	NODE_WIDTH,
	parentOf,
	pruneEdges,
	syncTones,
	wouldCreateCycle,
} from '../lib/layout';
import { handlesFor, withAdaptiveHandles } from '../lib/handles';
import { childCounts, visibleGraph } from '../lib/visibility';
import { applySiblingOrder, distanceToBox, insideBox, reparentMany, resolveDropMode } from '../lib/reparent';
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

/**
 * What a drop would do, resolved from the pointer position.
 *
 * `forbidden` means the drop is refused: the node goes back where it started.
 * It is used when hovering the root's outer bands, where "become a sibling of
 * the root" would really mean detaching — which is no longer allowed.
 */
interface DropHint {
	id: string;
	mode: 'child' | 'sibling-before' | 'sibling-after' | 'forbidden';
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
	 * Sharing state, mirrored from the document.
	 *
	 * `null` means not shared. The panel opens from the toolbar button; the
	 * dashboard has the same feature, but having to leave the editor to share the
	 * map you are looking at was awkward.
	 */
	const [shareToken, setShareToken] = useState<string | null>(null);
	const [shareOpen, setShareOpen] = useState(false);
	const [shareBusy, setShareBusy] = useState(false);
	/**
	 * Mirror of `dropHint` kept in a ref.
	 *
	 * `onNodeDragStop` must read the *final* hover target synchronously: React
	 * may not have committed the last `setDropHint` from `onNodeDrag` by the time
	 * the drop fires, and reading the state variable then yields a stale value.
	 */
	const dropHintRef = useRef<DropHint | null>(null);
	const canvasRef = useRef<HTMLDivElement | null>(null);
	/**
	 * Id of the map's primary root.
	 *
	 * Needed during a drag: the root has no parent, so dropping on its outer bands
	 * cannot mean "become a sibling of the root" — that is reported as forbidden.
	 */
	const rootIdRef = useRef<string | null>(null);
	/** True while the ROOT itself is being dragged (drives the warning wording). */
	const draggingRootRef = useRef(false);

	const { fitView, getViewport, screenToFlowPosition } = useReactFlow();
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
				const pruned = pruneEdges(doc.nodes, doc.edges);
				// tone must reflect the real depth: older documents (or nodes whose
				// position changed) can carry stale tones, which is what made some
				// nodes accent-coloured and others white.
				const toned = syncTones(doc.nodes, pruned);
				const counts = childCounts(toned, pruned);
				const withCounts = toned.map((n) => ({
					...n,
					data: { ...n.data, childCount: counts.get(n.id) ?? 0 },
				}));

				/**
				 * Re-run the layout on load.
				 *
				 * Saved coordinates can be stale or degenerate — detached nodes in
				 * particular were once persisted at (0,0), so opening such a
				 * document showed them piled on one point. Recomputing from the
				 * structure guarantees a sane arrangement regardless of what was
				 * stored, and keeps the visual identical to a fresh "整理布局".
				 */
				const struct = getStructure(doc.structure);
				const laidOut = layoutTree(withCounts, pruned, struct);

				setNodes(laidOut);
				setEdges(pruned);
				setThemeId(doc.theme || 'classic');
				setStructure(struct);
				setShareToken(map.shareToken ?? null);
				history.reset();
				requestAnimationFrame(() => {
					// the stored viewport may point at the old arrangement; re-fit
					// whenever we just relaid everything out
					fitView({ padding: 0.25, duration: 300 });
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
	}, [mapId, fitView]);

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

	/**
	 * Re-run the chosen structure's layout over the whole tree.
	 *
	 * `keepPinned` controls whether nodes the user dragged to a custom spot are
	 * respected. Structural changes pass false (see `relayoutAll`).
	 */
	const relayout = useCallback(
		(nds: MindNode[], eds: Edge[], sid: StructureId, keepPinned = true): MindNode[] =>
			layoutTree(syncChildCounts(nds, eds), eds, sid, { keepPinned }),
		[syncChildCounts],
	);

	/**
	 * Full re-layout that also clears manual placements.
	 *
	 * Used whenever the STRUCTURE changes (add/remove node, re-parent, collapse).
	 * Keeping stale pinned coordinates during a structural change produced a mess:
	 * moved nodes stayed at their old spot while their new siblings were laid out
	 * elsewhere, so the tree looked scrambled and "整理布局" could not fix it.
	 */
	const relayoutAll = useCallback(
		(nds: MindNode[], eds: Edge[], sid: StructureId): MindNode[] =>
			relayout(nds, eds, sid, false),
		[relayout],
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
				// linking two existing nodes must not re-flow the canvas; only update
				// the child counts so the collapse badges stay accurate
				setNodes((nds) => syncChildCounts(nds, next));
			});
			markDirty();
		},
		[nodes, edges, markDirty, withHistory, structure, syncChildCounts],
	);

	/**
	 * Nodes that travel together on this drag.
	 *
	 * When several nodes are selected, dragging any of them moves the WHOLE
	 * selection (that is what a multi-select drag means). The selection is captured
	 * at drag start so later `setDropHint` re-renders cannot change it mid-gesture.
	 */
	const dragIdsRef = useRef<string[]>([]);

	// ---- drag to reparent / reorder ----
	const onNodeDragStart = useCallback(
		(_event: MouseEvent | TouchEvent, node: MindNode) => {
			dragOrigin.current = {
				// clone so later state updates can never mutate the snapshot
				nodes: latest.current.nodes.map((n) => ({ ...n, data: { ...n.data } })),
				edges: latest.current.edges.map((e) => ({ ...e })),
			};
			// capture the full selection (or just this node when it is not selected)
			const selectedIds = latest.current.nodes.filter((n) => n.selected).map((n) => n.id);
			dragIdsRef.current = selectedIds.includes(node.id) && selectedIds.length > 1
				? selectedIds
				: [node.id];

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
			// `targets` excludes every node being dragged: they follow the pointer,
			// so they would always win the hit-test — and with a multi-selection that
			// means the whole batch must be excluded.
			const movingSet = new Set(dragIdsRef.current.length ? dragIdsRef.current : [dragged.id]);
			const targets: { id: string; x: number; y: number; w: number; h: number }[] = [];

			for (const el of document.querySelectorAll<HTMLElement>('.mind-node[data-node-id]')) {
				const id = el.dataset.nodeId;
				if (!id) continue;
				const r = el.getBoundingClientRect();
				const tl = screenToFlowPosition({ x: r.left, y: r.top });
				const br = screenToFlowPosition({ x: r.right, y: r.bottom });
				const box = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };

				if (movingSet.has(id)) continue;
				targets.push({ id, ...box });
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

			/**
			 * Two cases are refused outright, and both show a RED warning so the
			 * user learns the rule before releasing:
			 *
			 * 1. dropping ON the root's outer bands — the root has no parent, so
			 *    "become its sibling" would silently detach the node;
			 * 2. dragging the ROOT itself onto any other node — a root has no parent
			 *    by definition, and attaching it would create a cycle.
			 */
			const draggingRoot = movingSet.has(rootIdRef.current ?? '');
			draggingRootRef.current = draggingRoot;
			if (hit) {
				const onRootBands =
					hit.id === rootIdRef.current &&
					(hit.mode === 'sibling-before' || hit.mode === 'sibling-after');
				if (draggingRoot || onRootBands) {
					hit = { id: '', mode: 'forbidden' };
				}
			}

			const next: DropHint | null = hit;

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

			const movingIds = dragIdsRef.current.length ? dragIdsRef.current : [dragged.id];
			dragIdsRef.current = [];

			/** Put the dragged nodes back exactly where the gesture started. */
			const restore = () => {
				setNodes((nds) =>
					nds.map((n) => {
						const before = origin.nodes.find((o) => o.id === n.id);
						return before && movingIds.includes(n.id) ? { ...n, position: before.position } : n;
					}),
				);
			};

			/**
			 * Forbidden drop: refuse it and snap back.
			 *
			 * Covers both the root's outer bands (no siblings to insert next to) and
			 * dragging the root itself onto another node (would create a cycle). The
			 * user sees a red warning while hovering, then the node returns home.
			 */
			if (hint && hint.mode === 'forbidden') {
				restore();
				const wasRoot = movingIds.includes(rootIdRef.current ?? '');
				toast(
					wasRoot ? '根节点不能挂到其他节点上' : '这个位置不能放，节点已放回原位',
					'error',
				);
				return;
			}

			/**
			 * No snap target: the user simply moved the node somewhere on the canvas.
			 *
			 * Instead of snapping it back (which made free dragging useless), we keep
			 * the new position and mark the node `pinned`. Pinned nodes are excluded
			 * from the auto-layout, so a manual arrangement survives later edits while
			 * structural drops (onto another node) still re-flow the tree.
			 */
			if (!hint) {
				setNodes((nds) =>
					nds.map((n) =>
						movingIds.includes(n.id) ? { ...n, data: { ...n.data, pinned: true } } : n,
					),
				);
				markDirty();
				return;
			}

			// NOTE: DropHint uses `id`; reparentMany expects `hoveredId` — map it.
			// `forbidden` already returned above, so the mode is a real drop mode here.
			const target =
				hint.mode === 'forbidden'
					? null
					: { mode: hint.mode as 'child' | 'sibling-before' | 'sibling-after', hoveredId: hint.id };
			if (!target) {
				restore();
				return;
			}

			const result = reparentMany(origin.edges, movingIds, target);
			if (!result) {
				restore();
				toast('这个位置放不了，节点已放回原位', 'error');
				return;
			}

			history.push(origin);
			const nextEdges = result.edges;
			setEdges(nextEdges);
			setNodes((nds) => {
				const ordered = applySiblingOrder(nds, nextEdges);
				/**
				 * Re-parent ONE node, leave the rest of the canvas alone.
				 *
				 * The moved nodes are flagged `needsPlacement` so the incremental pass
				 * computes a spot for just them; every other node keeps the position the
				 * user already arranged.
				 */
				const staged = ordered.map((n) =>
					movingIds.includes(n.id)
						? { ...n, data: { ...n.data, pinned: false, needsPlacement: true } }
						: n,
				);
				return layoutTree(staged, nextEdges, structure, {
					keepPinned: true,
					preserveExisting: true,
				});
			});
			markDirty();

			const count = movingIds.length;
			const suffix = count > 1 ? `（${count} 个主题）` : '';
			if (target.mode === 'child') toast(`已改为子主题${suffix}`, 'success');
			else toast(`已调整同级顺序${suffix}`, 'success');
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

			/**
			 * A new node inherits the side its parent sits on.
			 *
			 * In the two-sided structure, giving the new child the correct side up
			 * front stops it from being dumped on the opposite half — which used to
			 * make the whole map appear to "curl up" when a node was added on one side.
			 *
			 * When the PARENT IS THE ROOT, there is no inherited side: we balance
			 * whichever half currently has fewer children, so repeatedly adding to
			 * the root still produces a genuinely two-sided map instead of pushing
			 * everything to the right.
			 */
			const rootNode = nodes.find((n) => n.data.tone === 'root');
			let side: 'left' | 'right' | undefined;
			// only the two-sided structure needs side flags; the fishbone's
			// bones alternate above/below the spine by order, no flags involved
			const twoSided = structure === 'both';
			if (parent && rootNode) {
				if (parent.id !== rootNode.id) {
					if (parent.data.side === 'left' || parent.data.side === 'right') {
						side = parent.data.side;
					} else if (Number.isFinite(parent.position?.x)) {
						side = parent.position.x < rootNode.position.x ? 'left' : 'right';
					}
				} else if (twoSided) {
					// parent is the root: balance the two halves
					const kids = nodes.filter((n) =>
						edges.some((e) => e.source === rootNode.id && e.target === n.id),
					);
					let l = 0;
					let r = 0;
					for (const k of kids) {
						if (k.data.side === 'left') l++;
						else if (k.data.side === 'right') r++;
						else if (Number.isFinite(k.position?.x)) {
							if (k.position.x < rootNode.position.x) l++;
							else r++;
						}
					}
					side = r <= l ? 'right' : 'left';
				}
			}

			const newNode: MindNode = {
				id,
				type: 'mind',
				position: parent
					? {
							x: parent.position.x + (side === 'left' ? -(NODE_WIDTH + 76) : NODE_WIDTH + 76),
							y: parent.position.y + 90,
						}
					: { x: 0, y: 0 },
				data: {
					label: '新主题',
					tone,
					editing: true,
					images: [],
					uploading: 0,
					childCount: 0,
					// let the incremental layout position this node
					needsPlacement: true,
					...(side ? { side } : {}),
				},
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
					/**
					 * Incremental placement: only the NEW node gets coordinates.
					 *
					 * `preserveExisting` leaves every node already on the canvas exactly
					 * where it is, so adding one child never re-flows the map. That was
					 * the "加一个节点整张图就盘起来" complaint.
					 */
					return layoutTree(nextNodes, nextEdges, structure, {
						keepPinned: true,
						preserveExisting: true,
					});
				});
			});

			markDirty();
			requestAnimationFrame(() => fitView({ padding: 0.3, duration: 260 }));
		},
		[nodes, edges, markDirty, readOnly, fitView, withHistory, structure],
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

	/**
	 * "整理布局": force a full re-arrangement.
	 *
	 * Uses `relayoutAll` so every manual placement is cleared — otherwise the nodes
	 * a user had dragged around stayed put and the button appeared to do nothing.
	 */
	const autoLayout = useCallback(() => {
		withHistory(() => setNodes((nds) => relayoutAll(nds, edges, structure)));
		markDirty();
		requestAnimationFrame(() => fitView({ padding: 0.25, duration: 300 }));
	}, [edges, markDirty, fitView, withHistory, structure, relayoutAll]);

	// ---- sharing ----
	/** Turn sharing on (or off) and keep the local token in sync. */
	const toggleShare = useCallback(
		async (enabled: boolean) => {
			if (shareBusy) return;
			setShareBusy(true);
			try {
				const { shareToken: token } = await api.setShare(mapId, enabled);
				setShareToken(token);
				if (enabled && token) {
					const url = `${window.location.origin}/s/${token}`;
					await navigator.clipboard.writeText(url).catch(() => undefined);
					toast('分享链接已复制', 'success');
				} else {
					toast('已关闭分享', 'success');
				}
			} catch {
				toast('操作失败', 'error');
			} finally {
				setShareBusy(false);
			}
		},
		[mapId, shareBusy],
	);

	/**
	 * Issue a NEW share token.
	 *
	 * A share link is a bearer token: once it has been forwarded there is no way
	 * to revoke it short of rotating. The old link stops working immediately.
	 */
	const resetShareLink = useCallback(async () => {
		if (shareBusy) return;
		setShareBusy(true);
		try {
			const { shareToken: token } = await api.resetShare(mapId);
			setShareToken(token);
			if (token) {
				const url = `${window.location.origin}/s/${token}`;
				await navigator.clipboard.writeText(url).catch(() => undefined);
				toast('已生成新链接，旧链接已失效', 'success');
			}
		} catch {
			toast('操作失败', 'error');
		} finally {
			setShareBusy(false);
		}
	}, [mapId, shareBusy]);

	/** Copy the current link again (the panel's "复制链接" button). */
	const copyShareLink = useCallback(async () => {
		if (!shareToken) return;
		const url = `${window.location.origin}/s/${shareToken}`;
		try {
			await navigator.clipboard.writeText(url);
			toast('分享链接已复制', 'success');
		} catch {
			toast('复制失败，请手动选择链接', 'error');
		}
	}, [shareToken]);

	// ---- structure switch ----
	const changeStructure = useCallback(
		(sid: StructureId) => {
			setStructure(sid);
			setNodes((nds) => {
				let next = nds;
				// Side flags exist only for the two-sided structure. The fishbone
				// alternates its branches above/below the spine by order, so the
				// full relayout below is all it takes.
				if (sid === 'both') {
					const root = next.find((n) => n.data.tone === 'root');
					if (root) {
						const kids = childrenOf(edges, root.id);
						const byId = new Map(next.map((n) => [n.id, n]));
						const sideOf = new Map<string, 'left' | 'right'>();

						/**
						 * Preserve sides that are already assigned, and only balance the
						 * ones that have none.
						 *
						 * Alternating purely by index (the old code) re-shuffled every
						 * child whenever the list changed length, so simply adding a node
						 * flipped the whole map's sides.
						 */
						let rightCount = 0;
						let leftCount = 0;
						for (const id of kids) {
							const flag = byId.get(id)?.data?.side;
							if (flag === 'left') {
								sideOf.set(id, 'left');
								leftCount++;
							} else if (flag === 'right') {
								sideOf.set(id, 'right');
								rightCount++;
							}
						}
						for (const id of kids) {
							if (sideOf.has(id)) continue;
							// no explicit side: keep the current x if it means something,
							// otherwise balance the halves
							const x = byId.get(id)?.position?.x;
							let side: 'left' | 'right';
							if (typeof x === 'number' && Number.isFinite(x) && Math.abs(x - root.position.x) > 1) {
								side = x < root.position.x ? 'left' : 'right';
							} else {
								side = rightCount <= leftCount ? 'right' : 'left';
							}
							sideOf.set(id, side);
							if (side === 'right') rightCount++;
							else leftCount++;
						}

						/**
						 * If every child landed on the same side, the geometry told us
						 * nothing (a fresh map puts each child to the RIGHT of its parent,
						 * so all of them look "right"). Alternate by order instead, or the
						 * two-sided structure would render as a plain one-sided map — the
						 * reported "两侧平衡图 全部在一边".
						 */
						if ((leftCount === 0 || rightCount === 0) && kids.length > 1) {
							sideOf.clear();
							kids.forEach((id, i) => sideOf.set(id, i % 2 === 0 ? 'right' : 'left'));
						}

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
				return layoutTree(next, edges, sid, { keepPinned: false });
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
					// Collapsing only hides/shows nodes; it must not move the ones that
					// stay visible. `preserveExisting` keeps every settled node put.
					return layoutTree(next, edges, structure, {
						keepPinned: true,
						preserveExisting: true,
					});
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
				return layoutTree(next, edges, structure, {
					keepPinned: true,
					preserveExisting: true,
				});
			});
		});
		markDirty();
		requestAnimationFrame(() => fitView({ padding: 0.3, duration: 300 }));
	}, [edges, markDirty, readOnly, withHistory, structure, fitView]);

	const expandAll = useCallback(() => {
		if (readOnly) return;
		withHistory(() => {
			setNodes((nds) => {
				const next = nds.map((n) => ({ ...n, data: { ...n.data, collapsed: false } }));
				// Expanding can reveal nodes that were never positioned: the incremental
				// pass gives those a spot without disturbing anything else.
				return layoutTree(next, edges, structure, {
					keepPinned: true,
					preserveExisting: true,
				});
			});
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

	/**
	 * After a label edit, only nudge spacing if the text got much taller.
	 *
	 * Previously every label commit re-flowed the whole map, so typing a longer
	 * title shuffled every node. Now the map stays put; nodes that would overlap
	 * are the only thing the incremental pass touches.
	 */
	useEffect(() => {
		const onCommit = () => {
			setNodes((nds) =>
				layoutTree(nds, latest.current.edges, latest.current.structure, {
					keepPinned: true,
					preserveExisting: true,
				}),
			);
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
					// Removing a connector must not move the nodes around it.
					setNodes((nds) => syncChildCounts(nds, next));
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
		// remember which node is the primary root; the drag handler needs it to
		// distinguish "drop on the root's edge" (detach) from "become its child"
		rootIdRef.current =
			visible.nodes.find((n) => n.data.tone === 'root')?.id ??
			visible.nodes[0]?.id ??
			null;
		const routed = withAdaptiveHandles(visible.nodes, visible.edges, structure);
		/**
		 * Highlight the node under the pointer.
		 *
		 * `forbidden` has no target node, so nothing lights up — the red warning
		 * banner carries the message instead.
		 */
		const hoveredId = dropHint && dropHint.mode !== 'forbidden' ? dropHint.id : null;
		const dropMode: 'child' | 'sibling-before' | 'sibling-after' | null =
			dropHint && dropHint.mode !== 'forbidden' ? dropHint.mode : null;
		const marked = hoveredId
			? visible.nodes.map((n) =>
					n.id === hoveredId
						? { ...n, data: { ...n.data, dropTarget: dropMode } }
						: { ...n, data: { ...n.data, dropTarget: null } },
				)
			: visible.nodes.some((n) => n.data.dropTarget)
				? visible.nodes.map((n) => ({ ...n, data: { ...n.data, dropTarget: null } }))
				: visible.nodes;

		// Rainbow themes need each connector to know its branch, so the hue of a
		// link matches the subtree it belongs to.
		const branchOf = new Map(visible.nodes.map((n) => [n.id, n.data.branchIndex ?? null]));
		const coloured = routed.map((e) => {
			const bi = branchOf.get(e.target) ?? branchOf.get(e.source) ?? null;
			return { ...e, data: { ...e.data, branchIndex: bi } };
		});

		return { ...visible, nodes: marked, edges: coloured };
	}, [nodes, edges, structure, dropHint]);

	const stats = useMemo(() => ({ nodes: nodes.length, edges: edges.length }), [nodes, edges]);

	/**
	 * Drive the collapse/expand pair's enabled state.
	 *
	 * "全部折叠" is pointless when nothing has children (or everything is already
	 * collapsed); "全部展开" is pointless when nothing is collapsed. Grey them out
	 * instead of letting the user click a no-op.
	 */
	const collapseState = useMemo(() => {
		const counts = childCounts(nodes, edges);
		const withChildren = nodes.filter((n) => (counts.get(n.id) ?? 0) > 0);
		const collapsed = withChildren.filter((n) => n.data.collapsed);
		return {
			hasExpandable: withChildren.length > collapsed.length,
			hasCollapsed: collapsed.length > 0,
		};
	}, [nodes, edges]);
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

						<MindLogo size={15} className="md-editor__badge" />
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

						{/* Collapse / expand pair: they belong together, so group them
						    like the undo/redo pair instead of offering only one. */}
						<div className="editor__pair">
							<button
								className="btn-ghost btn-icon-text"
								onClick={collapseAll}
								title="折叠所有分支，只看主干"
								disabled={readOnly || !collapseState.hasExpandable}
							>
								<ChevronsDownUp size={15} strokeWidth={1.9} />
								全部折叠
							</button>
							<button
								className="btn-ghost btn-icon-text"
								onClick={expandAll}
								title="展开所有已折叠的分支"
								disabled={readOnly || !collapseState.hasCollapsed}
							>
								<ChevronsUpDown size={15} strokeWidth={1.9} />
								全部展开
							</button>
						</div>

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
							className={`btn-ghost btn-icon-text${shareToken ? ' is-active' : ''}`}
							onClick={() => setShareOpen(true)}
							disabled={readOnly}
							title={shareToken ? '已分享 · 点击管理链接' : '生成只读分享链接'}
						>
							{shareToken ? <Link2 size={15} strokeWidth={1.9} /> : <Share2 size={15} strokeWidth={1.9} />}
							分享
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

				<div className="editor__canvas" style={{ background: theme.canvas }} ref={canvasRef}>
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
						/**
						 * React Flow makes each node wrapper focusable by default, and it
						 * grabs focus right after our edit-mode effect runs — which stole the
						 * caret from the textarea when a node was created with Tab/Enter.
						 * Turning that off lets the textarea keep focus.
						 */
						nodesFocusable={false}
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
						<div
							className={`drop-hint drop-hint--${dropHint.mode}${
								dropHint.mode === 'forbidden' ? ' is-warning' : ''
							}`}
						>
							{dropHint.mode === 'child' ? (
								<>
									<CornerDownRight size={13} strokeWidth={2.2} />
									松手成为子主题
								</>
							) : dropHint.mode === 'sibling-before' ? (
								<>
									<CornerDownRight size={13} strokeWidth={2.2} />
									松手插入到此主题之前
								</>
							) : dropHint.mode === 'sibling-after' ? (
								<>
									<CornerDownRight size={13} strokeWidth={2.2} />
									松手插入到此主题之后
								</>
							) : (
								<>
									<TriangleAlert size={13} strokeWidth={2.2} />
									{draggingRootRef.current
										? '根节点不能挂到其他节点上'
										: '根节点没有兄弟，不能放在这里'}
								</>
							)}
						</div>
					) : null}
				</div>

				{/*
				  Share panel: opens from the toolbar. Kept minimal on purpose —
				  one link, one copy button, one toggle. Sharing is a two-state
				  feature, not a settings screen.
				*/}
				{shareOpen ? (
					<div className="modal-mask" onClick={() => setShareOpen(false)}>
						<div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
							<h3>分享「{title || '未命名导图'}」</h3>

							{shareToken ? (
								<>
									<p className="modal__hint">
										任何拿到链接的人都可以查看这张导图（只读，不能修改）。
									</p>
									<div className="share-row">
										<input
											readOnly
											value={`${window.location.origin}/s/${shareToken}`}
											onFocus={(e) => e.currentTarget.select()}
										/>
										<button className="btn-primary btn-icon-text" onClick={() => void copyShareLink()}>
											<Copy size={15} strokeWidth={1.9} />
											复制
										</button>
									</div>
									<div className="modal__actions">
										<button
											className="btn-ghost btn-icon-text"
											onClick={() => void resetShareLink()}
											disabled={shareBusy}
											title="生成新链接，旧链接立即失效"
										>
											<RefreshCw size={15} strokeWidth={1.9} />
											{shareBusy ? '处理中…' : '换一个链接'}
										</button>
										<button
											className="btn-ghost danger"
											onClick={() => void toggleShare(false)}
											disabled={shareBusy}
										>
											关闭分享
										</button>
										<button className="btn-ghost" onClick={() => setShareOpen(false)}>
											完成
										</button>
									</div>
								</>
							) : (
								<>
									<p className="modal__hint">
										生成一条只读链接，发给别人就能查看这张导图。链接可以随时关闭。
									</p>
									<div className="modal__actions">
										<button className="btn-ghost" onClick={() => setShareOpen(false)}>
											取消
										</button>
										<button
											className="btn-primary btn-icon-text"
											onClick={() => void toggleShare(true)}
											disabled={shareBusy}
										>
											<Share2 size={15} strokeWidth={1.9} />
											{shareBusy ? '生成中…' : '生成分享链接'}
										</button>
									</div>
								</>
							)}
						</div>
					</div>
				) : null}

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
