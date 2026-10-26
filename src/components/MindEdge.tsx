import { memo, useEffect, useRef, useState } from 'react';
import {
	BaseEdge,
	EdgeLabelRenderer,
	getSmoothStepPath,
	useReactFlow,
	type EdgeProps,
} from '@xyflow/react';
import { Trash2, X } from 'lucide-react';

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

	const edgeData = (data ?? {}) as MindEdgeData;
	const editing = Boolean(edgeData.editing);
	// `label` is the canonical field; data.label mirrors it for in-place edits
	const shownLabel = typeof label === 'string' && label ? label : edgeData.label;

	const [path, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		borderRadius: 14,
	});

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
					stroke: selected || hovered ? '#818cf8' : (style?.stroke ?? '#cbd5e1'),
					strokeWidth: selected || hovered ? 2.4 : (style?.strokeWidth ?? 1.8),
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
