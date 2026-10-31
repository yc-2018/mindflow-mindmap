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
import { resolveEdgeColor } from '../lib/themes';
import { useReadOnly, useTheme } from '../lib/themeContext';

/** Window event fired when an edge's delete button is pressed. */
export const REMOVE_EDGE_EVENT = 'mindflow:remove-edge';
/** Window event fired when an edge label is committed (the editor owns edge state). */
export const EDGE_LABEL_EVENT = 'mindflow:edge-label';

export interface MindEdgeData extends Record<string, unknown> {
	label?: string;
	/** True while the connector label is being edited in place. */
	editing?: boolean;
	/**
	 * Fishbone drawing style, set by withAdaptiveHandles for the fishbone
	 * structure: "bone" = the spine run plus the 60° diagonal, "rib" = the
	 * horizontal line from the bone to the box's left edge.
	 */
	fishbone?: 'bone' | 'rib' | null;
}

/**
 * Orthogonal connector: horizontal run first, then vertical, with a rounded
 * corner. The vertical happens at the TARGET's x.
 *
 * Every child of one parent shares the parent's y, so their horizontal runs
 * are COLLINEAR (they overlap along a single line, which reads as one rib),
 * and their vertical runs all sit on the same target column — also collinear.
 * Collinear segments never cross; anything that bulges outside the segment
 * (a bezier scored 28 crossings on a real 80-node map) cuts through siblings.
 */
function orthPath(sx: number, sy: number, tx: number, ty: number, radius = 8): string {
	const dx = tx - sx;
	const dy = ty - sy;

	// already aligned: a plain straight run
	if (Math.abs(dy) < 0.5 || Math.abs(dx) < 0.5) {
		return `M${sx},${sy} L${tx},${ty}`;
	}

	const rr = Math.min(radius, Math.abs(dx) / 2, Math.abs(dy) / 2);
	const xDir = Math.sign(dx);
	const yDir = Math.sign(dy);

	// horizontal to just before the corner, quadratic around it, then vertical
	const cornerStartX = tx - xDir * rr;
	const cornerEndY = sy + yDir * rr;

	return (
		`M${sx},${sy} ` +
		`L${cornerStartX},${sy} ` +
		`Q${tx},${sy} ${tx},${cornerEndY} ` +
		`L${tx},${ty}`
	);
}

/** A 60° bone rises V over V·TAN30 — the slope of every ProcessOn ishikawa bone. */
const BONE_TAN30 = 1 / Math.sqrt(3);

/**
 * Pick a connector path based on which handles the edge uses.
 *
 * Fishbone edges come first: their shapes are fixed by the fishbone geometry
 * itself (one spine, 60° diagonals, horizontal ribs), not by the generic
 * elbow/curve rules.
 *
 * `lib/handles.ts` already flips the handles when a node sits behind its parent
 * (source-left / target-right), so by the time we get here the geometry is
 * always "leave on this side, arrive on that side" — no big loop is possible.
 *
 * Exported so the dashboard thumbnail can draw EXACTLY what the editor draws
 * (it used to draw its own bezier curves, so fishbone cards showed a curly
 * mind map instead of the fish — "缩略图和里面的图不一样").
 */
export function pickPath(args: {
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	sourcePosition: EdgeProps['sourcePosition'];
	targetPosition: EdgeProps['targetPosition'];
	sourceHandleId?: string | null;
	targetHandleId?: string | null;
	fishbone?: 'bone' | 'rib' | null;
}) {
	const { sourceX, sourceY, targetX, targetY, sourceHandleId, targetHandleId } = args;

	if (args.fishbone === 'bone') {
		/**
		 * The spine run plus the bone. The head's right handle sits ON the spine
		 * and the branch box's bottom/top handle is the bone's tip, so the foot —
		 * where the diagonal leaves the spine — is the tip shifted back along the
		 * 60° slope. Every bone's spine run is collinear, so the whole set
		 * renders as one spine line with bones branching off it, exactly like
		 * ProcessOn's fishbone.
		 */
		const footX = targetX - Math.abs(targetY - sourceY) * BONE_TAN30;
		return {
			path: `M${sourceX},${sourceY} L${footX},${sourceY} L${targetX},${targetY}`,
			labelX: (sourceX + footX) / 2,
			labelY: sourceY - 14,
		};
	}

	if (args.fishbone === 'rib') {
		/**
		 * A rib: a horizontal line from the BONE to the box's left edge. The
		 * source handle is the branch box's bone-side tip; the bone is a 60°
		 * line through that point, so its crossing at the rib's level is the
		 * tip shifted back by the vertical drop times the same slope.
		 */
		const boneX = sourceX - Math.abs(targetY - sourceY) * BONE_TAN30;
		return {
			path: `M${boneX},${targetY} L${targetX},${targetY}`,
			labelX: (boneX + targetX) / 2,
			labelY: targetY - 12,
		};
	}

	const dx = Math.abs(targetX - sourceX);
	const dy = Math.abs(targetY - sourceY);

	/**
	 * Any connector that ENTERS a node from its top/bottom edge is a rib, so it
	 * gets the orthogonal route whose vertical segment lands on the target's own
	 * column. Siblings then share one horizontal line and one vertical line —
	 * they overlap but can never cross.
	 *
	 * Keying off the TARGET handle (not a dy/dx ratio) is essential: a rib's
	 * children can sit far apart horizontally, so a ratio test sent most of them
	 * down the generic elbow path, whose vertical segment lands on the midpoint
	 * x instead — and those midpoints cross each other (85 crossings in the
	 * browser versus 0 with this rule).
	 */
	const entersVertically =
		targetHandleId === HANDLE.targetTop || targetHandleId === HANDLE.targetBottom;

	if (entersVertically) {
		const path = orthPath(sourceX, sourceY, targetX, targetY, 8);
		return { path, labelX: (sourceX + targetX) / 2, labelY: (sourceY + targetY) / 2 };
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
	const readOnly = useReadOnly();

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
		targetHandleId,
		fishbone: edgeData.fishbone ?? null,
	});

	const active = selected || hovered;
	// Rainbow themes colour each connector with its branch's hue, so a whole
	// branch reads as one colour. The index rides on the edge data, set by the
	// editor when it builds the visible graph.
	const baseStroke =
		(style?.stroke as string) ||
		resolveEdgeColor(theme, (edgeData as { branchIndex?: number | null }).branchIndex);
	const stroke = active
		? theme.rainbow
			? baseStroke
			: theme.edge.active
		: baseStroke;

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
					{readOnly ? (
						shownLabel ? (
							<span className="mind-edge-label mind-edge-label--static">{shownLabel}</span>
						) : null
					) : editing ? (
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

					{hovered && !editing && !readOnly ? (
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
