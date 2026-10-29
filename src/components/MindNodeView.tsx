import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { ImagePlus, Loader2, Minus, Plus, X } from 'lucide-react';
import { MAX_IMAGES, type MindNode } from '../lib/types';
import { HANDLE } from '../lib/handles';
import { useTheme } from '../lib/themeContext';
import { useReadOnly } from '../lib/themeContext';
import { resolveNodeStyle } from '../lib/themes';
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
 * Mind-map node, modelled on ProcessOn's interaction:
 *
 *  - NO always-on "+" button. New nodes come from the keyboard (Tab / Enter) or
 *    the toolbar. The only button is the collapse toggle, shown solely when the
 *    node actually has children.
 *  - NO visible connection points. Connectors are created by dragging a node onto
 *    another one; the editor highlights the drop target instead.
 *  - Text is edited in place (double-click). Selecting text shows a format bar
 *    pinned directly UNDER the text, always in the same place.
 */
function MindNodeView({ id, data, selected }: NodeProps<MindNode>) {
	const tone = data.tone ?? 'leaf';
	const readOnly = useReadOnly();
	// in the shared view a node must never enter edit mode, even if the stored
	// document still carries a leftover `editing` flag
	const editing = Boolean(data.editing) && !readOnly;
	const images = data.images ?? [];
	const pending = data.uploading ?? 0;
	const childCount = data.childCount ?? 0;
	const collapsed = Boolean(data.collapsed);
	const hasChildren = childCount > 0;

	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const labelRef = useRef<HTMLDivElement | null>(null);
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
	 * Anchor for the format bar: the BOTTOM of the label box, horizontally
	 * centred. Using the label box (not the selection rect) is what makes the bar
	 * appear in the same place every time.
	 */
	const anchorFromLabel = () => {
		const el = labelRef.current ?? inputRef.current;
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.bottom };
	};

	const updateFormatBar = () => {
		const el = inputRef.current;
		if (!el) return;
		const { selectionStart: start, selectionEnd: end } = el;
		if (start === end) {
			setFormat(null);
			return;
		}
		const anchor = anchorFromLabel();
		if (!anchor) return;
		setFormat({ ...anchor, start, end });
	};

	// poll the textarea selection while editing so the bar tracks it reliably
	useEffect(() => {
		if (!editing) return;
		const timer = window.setInterval(() => {
			const el = inputRef.current;
			if (!el) return;
			if (document.activeElement !== el) return;
			const { selectionStart: start, selectionEnd: end } = el;
			setFormat((prev) => {
				if (start === end) return prev === null ? prev : null;
				if (prev && prev.start === start && prev.end === end) return prev;
				const anchor = anchorFromLabel();
				if (!anchor) return prev;
				return { ...anchor, start, end };
			});
		}, 180);
		return () => window.clearInterval(timer);
	}, [editing]);

	const applyFormat = (kind: FormatKind) => {
		const el = inputRef.current;
		if (!el || !format) return;
		const result = wrapSelection(draft, format.start, format.end, kind);
		setDraft(result.text);
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
	// Rainbow themes colour each top-level branch differently; other themes ignore
	// branchIndex and fall back to the plain tone colours.
	const palette = resolveNodeStyle(theme, tone, data.branchIndex);
	const dropTarget = data.dropTarget ?? null;
	// the branch's own hue drives selection rings and the collapse badge too
	const accent = theme.rainbow && typeof data.branchIndex === 'number' ? palette.border : theme.accent;

	return (
		<div
			className={`mind-node mind-node--${tone}${selected ? ' is-selected' : ''}${
				collapsed ? ' is-collapsed' : ''
			}${dropTarget ? ` is-drop-${dropTarget}` : ''}`}
			data-node-id={id}
			data-drop={dropTarget ?? undefined}
			style={
				{
					'--node-bg': palette.bg,
					'--node-border': palette.border,
					'--node-text': palette.text,
					'--node-accent': accent,
				} as React.CSSProperties
			}
		>
			{/* Connection points stay invisible: connectors are made by dragging a
			    node onto another, so there is nothing to click here. Keeping the
			    handles present is still required for React Flow to route edges. */}
			<Handle type="target" position={Position.Left} id={HANDLE.targetLeft} className="mind-handle" />
			<Handle type="source" position={Position.Left} id={HANDLE.sourceLeft} className="mind-handle" />
			<Handle type="source" position={Position.Right} id={HANDLE.sourceRight} className="mind-handle" />
			<Handle type="target" position={Position.Right} id={HANDLE.targetRight} className="mind-handle" />
			<Handle type="source" position={Position.Bottom} id={HANDLE.sourceBottom} className="mind-handle" />
			<Handle type="target" position={Position.Top} id={HANDLE.targetTop} className="mind-handle" />
			<Handle type="source" position={Position.Top} id={HANDLE.sourceTop} className="mind-handle" />
			<Handle type="target" position={Position.Bottom} id={HANDLE.targetBottom} className="mind-handle" />

			<div className="mind-node__label" ref={labelRef}>
				{editing ? (
					<textarea
						ref={inputRef}
						className="mind-node__input nodrag nopan"
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
				) : (
					<>
						<MarkdownLabel source={data.label || '未命名主题'} />
						{hasChildren && collapsed ? (
							<span className="mind-node__count" title={`${childCount} 个隐藏的子主题`}>
								{childCount}
							</span>
						) : null}
					</>
				)}
			</div>

			{format ? (
				<FormatBar
					anchor={{ x: format.x, y: format.y }}
					selection={{ start: format.start, end: format.end }}
					onApply={(kind) => applyFormat(kind)}
				/>
			) : null}

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
							{readOnly ? null : (
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
							)}
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

			{/* Only the collapse toggle exists, and only when there is something to
			    collapse. Adding children is keyboard-driven, like ProcessOn. */}
			{hasChildren && !editing ? (
				<button
					type="button"
					className={`mind-node__collapse nodrag nopan${collapsed ? ' is-collapsed' : ''}`}
					title={collapsed ? `展开 ${childCount} 个子主题` : `折叠 ${childCount} 个子主题`}
					onClick={(e) => {
						e.stopPropagation();
						window.dispatchEvent(new CustomEvent(TOGGLE_COLLAPSE_EVENT, { detail: { id } }));
					}}
				>
					{collapsed ? <Plus size={11} strokeWidth={2.8} /> : <Minus size={11} strokeWidth={2.8} />}
				</button>
			) : null}
		</div>
	);
}

export default memo(MindNodeView);
