import { memo, useEffect, useRef, useState } from 'react';
import {
	BaseEdge,
	EdgeLabelRenderer,
	getBezierPath,
	getSmoothStepPath,
	useReactFlow,
	type EdgeProps,
} from '@xyflow/react';
import { Trash2, X } from 'lucide-react';
import { HANDLE } from '../lib/handles';
import { useTheme } from '../lib/themeContext';

/** Window event fired when an edge's delete button is pressed. */
export const REMOVE_EDGE_EVENT = 'mindflow:remove-edge';
/** Window event fired when an edge label is committed (the editor owns edge state). */
export const EDGE_LABEL_EVENT = 'mindflow:edge-label';

export interface MindEdgeData extends Record<string, unknown> {
	label?: string;
	/** True while the connector label is being edited in place. */
	editing?: boolean;
}

/**
 * Pick a connector path based on which handles the edge uses.
 *
 * `lib/handles.ts` already flips the handles when a node sits behind its parent
 * (source-left / target-right), so by the time we get here the geometry is
 * always "leave on this side, arrive on that side" — no big loop is possible.
 * We only special-case the near-vertical / backwards situation, where a bezier
 * reads better than an elbow.
 */
function pickPath(args: {
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	sourcePosition: EdgeProps['sourcePosition'];
	targetPosition: EdgeProps['targetPosition'];
	sourceHandleId?: string | null;
}) {
	const { sourceX, sourceY, targetX, targetY, sourceHandleId } = args;

	const dx = Math.abs(targetX - sourceX);
	const dy = Math.abs(targetY - sourceY);

	// Fishbone ribs: the connector leaves the spine horizontally but enters the
	// rib's top/bottom edge, so a smooth step reads better than a bezier loop.
	const entersVertically =
		sourceHandleId === HANDLE.sourceRight && Math.abs(targetY - sourceY) > Math.abs(targetX - sourceX) * 0.6;

	if (entersVertically) {
		const [path, labelX, labelY] = getSmoothStepPath({
			...args,
			borderRadius: 12,
		});
		return { path, labelX, labelY };
	}

	// vertical connectors (top-down / bottom-up structures)
	const vertical =
		sourceHandleId === HANDLE.sourceBottom ||
		sourceHandleId === HANDLE.sourceTop;

	if (vertical) {
		const [path, labelX, labelY] = getSmoothStepPath({
			...args,
			borderRadius: Math.min(14, Math.max(6, dx / 3)),
		});
		return { path, labelX, labelY };
	}

	// leaving from the LEFT handle means the target is behind us: use a curve
	const leavingLeft = sourceHandleId === HANDLE.sourceLeft;

	if (leavingLeft || dx < 24) {
		const [path, labelX, labelY] = getBezierPath({
			sourceX,
			sourceY,
			sourcePosition: args.sourcePosition,
			targetX,
			targetY,
			targetPosition: args.targetPosition,
			// tighter arc when the nodes are close together
			curvature: dx < 120 ? 0.22 : 0.3,
		});
		return { path, labelX, labelY };
	}

	// normal forward layout: tidy elbow, softened when the drop is small
	const [path, labelX, labelY] = getSmoothStepPath({
		...args,
		borderRadius: Math.min(14, Math.max(6, dy / 3)),
	});
	return { path, labelX, labelY };
}

/**
 * Soft connector between two topics.
 *
 * - the label sits at the midpoint and is edited IN PLACE on double-click
 * - hovering reveals a delete button, so a stray connector is never stuck
 */
function MindEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	sourceHandleId,
	targetHandleId,
	label,
	data,
	markerEnd,
	style,
	selected,
}: EdgeProps) {
	const [hovered, setHovered] = useState(false);
	const [draft, setDraft] = useState('');
	const inputRef = useRef<HTMLInputElement | null>(null);
	const { updateEdgeData } = useReactFlow();
	const theme = useTheme();

	const edgeData = (data ?? {}) as MindEdgeData;
	const editing = Boolean(edgeData.editing);
	// `label` is the canonical field; data.label mirrors it for in-place edits
	const shownLabel = typeof label === 'string' && label ? label : edgeData.label;

	const { path, labelX, labelY } = pickPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		sourceHandleId,
	});

	const active = selected || hovered;
	const stroke = active ? theme.edge.active : (style?.stroke as string) || theme.edge.stroke;

	useEffect(() => {
		if (editing) {
			setDraft(edgeData.label ?? (typeof label === 'string' ? label : ''));
			requestAnimationFrame(() => {
				inputRef.current?.focus();
				inputRef.current?.select();
			});
		}
	}, [editing, edgeData.label, label]);

	const commit = () => {
		const clean = draft.trim();
		// clear the editing flag first so the input unmounts cleanly
		updateEdgeData(id, { editing: false, label: clean });
		// the editor owns the edge list; it writes the canonical `label` field
		window.dispatchEvent(new CustomEvent(EDGE_LABEL_EVENT, { detail: { id, label: clean } }));
	};

	return (
		<>
			<BaseEdge
				id={id}
				path={path}
				markerEnd={markerEnd}
				style={{
					...style,
					stroke,
					strokeWidth: active ? 2.4 : (style?.strokeWidth ?? 1.8),
					transition: 'stroke 0.15s ease',
				}}
			/>

			{/* a wide invisible path makes thin connectors easy to hover/click */}
			<path
				d={path}
				fill="none"
				stroke="transparent"
				strokeWidth={16}
				style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
			/>

			<EdgeLabelRenderer>
				<div
					className="mind-edge-mid nodrag nopan"
					style={{
						position: 'absolute',
						transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
						pointerEvents: 'all',
					}}
					onMouseEnter={() => setHovered(true)}
					onMouseLeave={() => setHovered(false)}
				>
					{editing ? (
						<input
							ref={inputRef}
							className="mind-edge-input"
							value={draft}
							placeholder="连线文字"
							onChange={(e) => setDraft(e.target.value)}
							onBlur={commit}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === 'Enter') commit();
								if (e.key === 'Escape') updateEdgeData(id, { editing: false });
							}}
						/>
					) : shownLabel ? (
						<button
							type="button"
							className="mind-edge-label"
							title="双击编辑文字"
							onClick={(e) => e.stopPropagation()}
						>
							{shownLabel}
						</button>
					) : null}

					{hovered && !editing ? (
						<button
							type="button"
							className="mind-edge-del"
							title="删除这条连线"
							onClick={(e) => {
								e.stopPropagation();
								window.dispatchEvent(new CustomEvent(REMOVE_EDGE_EVENT, { detail: { id } }));
							}}
						>
							{shownLabel ? <X size={10} strokeWidth={3} /> : <Trash2 size={11} strokeWidth={2.2} />}
						</button>
					) : null}
				</div>
			</EdgeLabelRenderer>
		</>
	);
}

export default memo(MindEdge);
