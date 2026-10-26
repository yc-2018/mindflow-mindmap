import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { ImagePlus, Loader2, Plus, X } from 'lucide-react';
import { MAX_IMAGES, type MindNode } from '../lib/types';
import MarkdownLabel from './MarkdownLabel';

/** Window event the editor listens to when a node's "+" button is pressed. */
export const ADD_CHILD_EVENT = 'mindflow:add-child';
/** Window event fired when a node thumbnail is clicked (opens the lightbox). */
export const OPEN_IMAGE_EVENT = 'mindflow:open-image';
/** Window event fired when a node's "add image" button is pressed. */
export const ADD_IMAGE_EVENT = 'mindflow:add-image';
/** Window event fired when a thumbnail's delete button is pressed. */
export const REMOVE_IMAGE_EVENT = 'mindflow:remove-image';

/**
 * Mind-map node: label on its own row at the top, then a row of small image
 * thumbnails underneath.
 *
 * Editing happens IN PLACE: double-click swaps the label for a textarea of the
 * same size, no floating dialog.
 */
function MindNodeView({ id, data, selected }: NodeProps<MindNode>) {
	const tone = data.tone ?? 'leaf';
	const editing = Boolean(data.editing);
	const images = data.images ?? [];
	const pending = data.uploading ?? 0;
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const [draft, setDraft] = useState(data.label);
	const { updateNodeData } = useReactFlow();

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

	return (
		<div className={`mind-node mind-node--${tone}${selected ? ' is-selected' : ''}`} data-node-id={id}>
			<Handle type="target" position={Position.Left} className="mind-handle" />
			<Handle type="source" position={Position.Right} className="mind-handle" />

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
											detail: {
												images,
												index,
												alt: data.label,
											},
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

					{/* one placeholder per in-flight upload, with a spinner */}
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
					className="mind-node__add nodrag nopan"
					title="添加子主题"
					onClick={(e) => {
						e.stopPropagation();
						window.dispatchEvent(new CustomEvent(ADD_CHILD_EVENT, { detail: { id } }));
					}}
				>
					<Plus size={13} strokeWidth={2.4} />
				</button>
			) : null}
		</div>
	);
}

export default memo(MindNodeView);
