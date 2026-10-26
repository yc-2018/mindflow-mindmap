import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { ImagePlus, Loader2, Minus, Plus, X } from 'lucide-react';
import { MAX_IMAGES, type MindNode } from '../lib/types';
import { HANDLE } from '../lib/handles';
import { useTheme } from '../lib/themeContext';
import MarkdownLabel from './MarkdownLabel';
import FormatBar, { wrapSelection, type FormatKind } from './FormatBar';

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
/** Window event fired when in-place editing commits (so the editor can relayout). */
export const LABEL_COMMIT_EVENT = 'mindflow:label-commit';

/**
 * Mind-map node: label on its own row at the top, then a row of small image
 * thumbnails underneath.
 *
 * Editing happens IN PLACE: double-click swaps the label for a textarea of the
 * same size, no floating dialog. Selecting text inside the editor pops a format
 * bar that writes Markdown/HTML into the stored label.
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
	const [format, setFormat] = useState<{ x: number; y: number; start: number; end: number } | null>(null);
	const { updateNodeData } = useReactFlow();
	const theme = useTheme();

	// reset the draft whenever this node enters edit mode
	useEffect(() => {
		if (editing) {
			setDraft(data.label);
			setFormat(null);
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

	/**
	 * Show the format bar whenever there is a non-empty selection.
	 *
	 * `onSelect` does not fire for programmatic selection changes (and some
	 * browsers skip it for keyboard selection), so we also poll while the node is
	 * in edit mode. The poll is cheap and stops as soon as editing ends.
	 */
	const updateFormatBar = () => {
		const el = inputRef.current;
		if (!el) return;
		const { selectionStart: start, selectionEnd: end } = el;
		if (start === end) {
			setFormat(null);
			return;
		}
		const rect = el.getBoundingClientRect();
		setFormat({
			x: rect.x + rect.width / 2,
			y: rect.y + 4,
			start,
			end,
		});
	};

	// poll the textarea selection while editing so the bar tracks it reliably
	useEffect(() => {
		if (!editing) return;
		const id = window.setInterval(() => {
			const el = inputRef.current;
			if (!el) return;
			if (document.activeElement !== el) return;
			const { selectionStart: start, selectionEnd: end } = el;
			setFormat((prev) => {
				if (start === end) return prev === null ? prev : null;
				if (prev && prev.start === start && prev.end === end) return prev;
				const rect = el.getBoundingClientRect();
				return { x: rect.x + rect.width / 2, y: rect.y + 4, start, end };
			});
		}, 220);
		return () => window.clearInterval(id);
	}, [editing]);

	const applyFormat = (kind: FormatKind) => {
		const el = inputRef.current;
		if (!el || !format) return;
		const result = wrapSelection(draft, format.start, format.end, kind);
		setDraft(result.text);
		// restore the selection after React re-renders the value
		requestAnimationFrame(() => {
			const node = inputRef.current;
			if (!node) return;
			node.focus();
			node.setSelectionRange(result.start, result.end);
			node.style.height = 'auto';
			node.style.height = `${node.scrollHeight}px`;
			updateFormatBar();
		});
	};

	const commit = () => {
		setFormat(null);
		const clean = draft.trim();
		const next = clean || data.label;
		updateNodeData(id, { label: next, editing: false });
		window.dispatchEvent(new CustomEvent(LABEL_COMMIT_EVENT, { detail: { id } }));
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
			{/* vertical pair, used by the top-down / bottom-up structures */}
			<Handle
				type="source"
				position={Position.Bottom}
				id={HANDLE.sourceBottom}
				className="mind-handle mind-handle--vertical"
			/>
			<Handle
				type="target"
				position={Position.Top}
				id={HANDLE.targetTop}
				className="mind-handle mind-handle--vertical"
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
						onSelect={updateFormatBar}
						onKeyUp={updateFormatBar}
						onMouseUp={updateFormatBar}
						onBlur={commit}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								commit();
								return;
							}
							if (e.key === 'Escape') {
								setFormat(null);
								updateNodeData(id, { editing: false });
								return;
							}
							// formatting shortcuts
							if (e.ctrlKey || e.metaKey) {
								const k = e.key.toLowerCase();
								if (k === 'b' || k === 'i' || k === 'u') {
									e.preventDefault();
									updateFormatBar();
									if (format) applyFormat(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline');
								}
							}
						}}
					/>
					{format ? (
						<FormatBar
							anchor={{ x: format.x, y: format.y }}
							selection={{ start: format.start, end: format.end }}
							onApply={(kind) => applyFormat(kind)}
						/>
					) : null}
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
