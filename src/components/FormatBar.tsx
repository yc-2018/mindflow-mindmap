import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
	Bold,
	Eraser,
	Highlighter,
	Italic,
	List,
	ListOrdered,
	Strikethrough,
	Underline,
} from 'lucide-react';

export type FormatKind =
	| 'bold'
	| 'italic'
	| 'underline'
	| 'strike'
	| 'highlight'
	| 'code'
	| 'list'
	| 'ordered-list'
	| 'clear';

interface Props {
	/** Screen coordinates of the anchor (bottom-centre of the selection). */
	anchor: { x: number; y: number };
	/** Current selection inside the textarea, in code units. */
	selection: { start: number; end: number };
	/** Apply a markdown wrapper to the selected range. */
	onApply: (kind: FormatKind, selectedText: string) => void;
}

/** Markdown snippet for each action. `$1` is the selected text. */
const WRAPPERS: Record<Exclude<FormatKind, 'list' | 'ordered-list' | 'clear'>, [string, string]> = {
	bold: ['**', '**'],
	italic: ['*', '*'],
	underline: ['<u>', '</u>'],
	strike: ['~~', '~~'],
	highlight: ['==', '=='],
	code: ['`', '`'],
};

interface Btn {
	kind: FormatKind;
	label: string;
	icon: React.ReactNode;
}

const BUTTONS: Btn[] = [
	{ kind: 'bold', label: '加粗 (Ctrl+B)', icon: <Bold size={14} strokeWidth={2.4} /> },
	{ kind: 'italic', label: '斜体 (Ctrl+I)', icon: <Italic size={14} strokeWidth={2.4} /> },
	{ kind: 'underline', label: '下划线 (Ctrl+U)', icon: <Underline size={14} strokeWidth={2.4} /> },
	{ kind: 'strike', label: '删除线', icon: <Strikethrough size={14} strokeWidth={2.4} /> },
	{ kind: 'highlight', label: '高亮', icon: <Highlighter size={14} strokeWidth={2.2} /> },
	{ kind: 'list', label: '无序列表', icon: <List size={14} strokeWidth={2.2} /> },
	{ kind: 'ordered-list', label: '有序列表', icon: <ListOrdered size={14} strokeWidth={2.2} /> },
	{ kind: 'clear', label: '清除格式', icon: <Eraser size={14} strokeWidth={2.2} /> },
];

/**
 * Floating format bar shown directly BELOW the node's text while editing.
 *
 * The bar is anchored to the editor box (not the selection rectangle): the
 * selection rectangle moves with the caret and would make the bar jump around,
 * which is exactly the "sometimes here, sometimes bottom-right" behaviour users
 * complained about. A fixed anchor under the text keeps it predictable.
 *
 * Actions insert Markdown/HTML snippets rather than mutating DOM ranges: the node
 * label is stored as Markdown, so wrapping the selected characters is the only
 * representation that survives a save/reload.
 */
export default function FormatBar({ anchor, selection, onApply }: Props) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	/**
	 * Position the bar directly UNDER the anchor (the node's text box), centred.
	 *
	 * The bar is rendered through a portal into <body> on purpose: inside React
	 * Flow's transformed viewport a `position: fixed` element resolves against the
	 * transformed ancestor instead of the window, which made the bar appear in the
	 * wrong place (sometimes bottom-right, sometimes off screen).
	 */
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		const left = Math.min(Math.max(8, anchor.x - w / 2), window.innerWidth - w - 8);
		let top = anchor.y + 6;
		// only flip above when there is genuinely no room below
		if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.y - h - 40);
		setPos({ x: left, y: top });
	}, [anchor]);

	const hasSelection = selection.end > selection.start;

	const node = (
		<div
			ref={ref}
			className="format-bar"
			style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
			// never steal focus from the textarea
			onMouseDown={(e) => e.preventDefault()}
		>
			{BUTTONS.map((b) => (
				<button
					key={b.kind}
					type="button"
					className={`format-bar__btn${b.kind === 'clear' ? ' is-danger' : ''}`}
					title={b.label}
					disabled={!hasSelection && b.kind !== 'clear'}
					onClick={() => onApply(b.kind, '')}
				>
					{b.icon}
				</button>
			))}
		</div>
	);

	// Guard against a missing body (SSR, or a portal rendered after unmount):
	// createPortal throws "Cannot read properties of null (reading 'document')"
	// when the container is gone.
	if (typeof document === 'undefined' || !document.body) return null;

	return createPortal(node, document.body);
}

/** Wrap (or unwrap) the selected text with the marker pair for `kind`. */
export function wrapSelection(
	text: string,
	start: number,
	end: number,
	kind: FormatKind,
): { text: string; start: number; end: number } {
	if (kind === 'clear') {
		// strip common markers from the whole label
		const cleaned = text
			.replace(/\*\*(.+?)\*\*/g, '$1')
			.replace(/~~(.+?)~~/g, '$1')
			.replace(/==(.+?)==/g, '$1')
			.replace(/<\/?u>/g, '')
			.replace(/`(.+?)`/g, '$1')
			.replace(/\*(.+?)\*/g, '$1');
		return { text: cleaned, start: 0, end: cleaned.length };
	}

	const selected = text.slice(start, end);

	if (kind === 'list' || kind === 'ordered-list') {
		// prefix every line in the selection
		const lines = selected.split('\n');
		const prefix = kind === 'list' ? '- ' : '1. ';
		const replaced = lines
			.map((l, i) => {
				const clean = l.replace(/^(\s*)([-*]|\d+\.)\s+/, '$1');
				return kind === 'ordered-list' ? `${i + 1}. ${clean}` : `- ${clean}`;
			})
			.join('\n');
		return {
			text: text.slice(0, start) + replaced + text.slice(end),
			start,
			end: start + replaced.length,
		};
	}

	const [open, close] = WRAPPERS[kind];
	// toggling: if already wrapped, unwrap
	if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) {
		const inner = selected.slice(open.length, selected.length - close.length);
		return {
			text: text.slice(0, start) + inner + text.slice(end),
			start,
			end: start + inner.length,
		};
	}

	const wrapped = `${open}${selected}${close}`;
	return {
		text: text.slice(0, start) + wrapped + text.slice(end),
		start: start + open.length,
		end: start + open.length + selected.length,
	};
}
