import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { ImagePlus, Loader2, Minus, Plus, X } from 'lucide-react';
import { MAX_IMAGES, type MindNode } from '../lib/types';
import { HANDLE } from '../lib/handles';
import { useTheme } from '../lib/themeContext';
import MarkdownLabel from './MarkdownLabel';

/** Window event the editor listens to when a node's "+" button is pressed. */
export const ADD_CHILD_EVENT = 'mindflow:add-child';
/** Window event fired when a node thumbnail is clicked (opens the lightbox). */
export const OPEN_IMAGE_EVENT = 'mindflow:open-image';
/** Window event fired when a node's "add image" button is pressed. */
export const ADD_IMAGE_EVENT = 'mindflow:add-image';
/** Window event fired when a thumbnail's delete button is pressed. */
export const REMOVE_IMAGE_EVENT = 'mindflow:remove-image';
/** Window event fired when a node's collapse toggle is pressed. */
export const TOGGLE_COLLAPSE_EVENT = 'mindflow:toggle-collapse';

/**
 * Mind-map node: label on its own row at the top, then a row of small image
 * thumbnails underneath.
 *
 * Editing happens IN PLACE: double-click swaps the label for a textarea of the
 * same size, no floating dialog.
 *
 * The trailing button is context aware:
 *  - a node with children shows "−" to collapse, "＋" when collapsed
 *  - a leaf shows "＋" to add its first child
 * Holding Shift on a collapsed node still adds a child instead of expanding.
 */
function MindNodeView({ id, data, selected }: NodeProps<MindNode>) {
	const tone = data.tone ?? 'leaf';
	const editing = Boolean(data.editing);
	const images = data.images ?? [];
	const pending = data.uploading ?? 0;
	const childCount = data.childCount ?? 0;
	const collapsed = Boolean(data.collapsed);
	const hasChildren = childCount > 0;

	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const [draft, setDraft] = useState(data.label);
	const { updateNodeData } = useReactFlow();
	const theme = useTheme();

	// reset the draft whenever this node enters edit mode
	useEffect(() => {
		if (editing) {
			setDraft(data.label);
			requestAnimationFrame(() => {
				const el = inputRef.current;
				if (!el) return;
				el.focus();
				el.select();
				el.style.height = 'auto';
				el.style.height = `${el.scrollHeight}px`;
			});
		}
	}, [editing, data.label]);

	const commit = () => {
		const clean = draft.trim();
		updateNodeData(id, { label: clean || data.label, editing: false });
	};

	const canAddMore = images.length + pending < MAX_IMAGES;
	const palette = theme[tone];

	return (
		<div
			className={`mind-node mind-node--${tone}${selected ? ' is-selected' : ''}${collapsed ? ' is-collapsed' : ''}`}
			data-node-id={id}
			style={
				{
					'--node-bg': palette.bg,
					'--node-border': palette.border,
					'--node-text': palette.text,
					'--node-accent': theme.accent,
				} as React.CSSProperties
			}
		>
			{/* Four handles: a source and a target on each side, so a connector can
			    always leave and enter on whichever side faces the other node.
			    Using explicit ids lets lib/handles.ts pick the shortest route. */}
			<Handle
				type="target"
				position={Position.Left}
				id={HANDLE.targetLeft}
				className="mind-handle"
			/>
			<Handle
				type="source"
				position={Position.Left}
				id={HANDLE.sourceLeft}
				className="mind-handle mind-handle--src-left"
			/>
			<Handle
				type="source"
				position={Position.Right}
				id={HANDLE.sourceRight}
				className="mind-handle"
			/>
			<Handle
				type="target"
				position={Position.Right}
				id={HANDLE.targetRight}
				className="mind-handle mind-handle--tgt-right"
			/>

			{editing ? (
				<div className="mind-node__label nodrag nopan">
					<textarea
						ref={inputRef}
						className="mind-node__input"
						value={draft}
						rows={1}
						onChange={(e) => {
							setDraft(e.target.value);
							e.target.style.height = 'auto';
							e.target.style.height = `${e.target.scrollHeight}px`;
						}}
						onBlur={commit}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								commit();
							}
							if (e.key === 'Escape') updateNodeData(id, { editing: false });
						}}
					/>
				</div>
			) : (
				<div className="mind-node__label">
					<MarkdownLabel source={data.label || '未命名主题'} />
					{hasChildren && collapsed ? (
						<span className="mind-node__count" title={`${childCount} 个隐藏的子主题`}>
							{childCount}
						</span>
					) : null}
				</div>
			)}

			{images.length || pending ? (
				<div className="mind-node__images nodrag nopan">
					{images.map((img, index) => (
						<div key={img.id} className="mind-thumb">
							<img
								src={img.thumbUrl}
								alt={`${data.label} 图片 ${index + 1}`}
								draggable={false}
								loading="lazy"
								title="点击查看大图"
								onClick={(e) => {
									e.stopPropagation();
									window.dispatchEvent(
										new CustomEvent(OPEN_IMAGE_EVENT, {
											detail: { images, index, alt: data.label },
										}),
									);
								}}
							/>
							<button
								type="button"
								className="mind-thumb__remove"
								title="删除这张图片"
								onClick={(e) => {
									e.stopPropagation();
									window.dispatchEvent(
										new CustomEvent(REMOVE_IMAGE_EVENT, {
											detail: { nodeId: id, imageId: img.id },
										}),
									);
								}}
							>
								<X size={9} strokeWidth={3} />
							</button>
						</div>
					))}

					{Array.from({ length: pending }).map((_, i) => (
						<div key={`pending-${i}`} className="mind-thumb mind-thumb--pending">
							<Loader2 size={13} className="spin" />
						</div>
					))}

					{canAddMore ? (
						<button
							type="button"
							className="mind-thumb__add"
							title={`添加图片（最多 ${MAX_IMAGES} 张）`}
							onClick={(e) => {
								e.stopPropagation();
								window.dispatchEvent(new CustomEvent(ADD_IMAGE_EVENT, { detail: { nodeId: id } }));
							}}
						>
							<ImagePlus size={12} strokeWidth={2} />
						</button>
					) : null}
				</div>
			) : null}

			{!editing ? (
				<button
					type="button"
					className={`mind-node__add nodrag nopan${hasChildren && !collapsed ? ' is-collapse' : ''}`}
					title={
						hasChildren
							? collapsed
								? `展开 ${childCount} 个子主题（Shift+点击 直接加子主题）`
								: `折叠 ${childCount} 个子主题`
							: '添加子主题'
					}
					onClick={(e) => {
						e.stopPropagation();
						if (hasChildren && !e.shiftKey) {
							window.dispatchEvent(new CustomEvent(TOGGLE_COLLAPSE_EVENT, { detail: { id } }));
							return;
						}
						window.dispatchEvent(new CustomEvent(ADD_CHILD_EVENT, { detail: { id } }));
					}}
				>
					{hasChildren && !collapsed ? (
						<Minus size={13} strokeWidth={2.8} />
					) : (
						<Plus size={13} strokeWidth={2.4} />
					)}
				</button>
			) : null}
		</div>
	);
}

export default memo(MindNodeView);
