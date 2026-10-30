import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Download, Eye, FileText, List, PenLine, SquareSplitHorizontal } from 'lucide-react';

import MarkdownRenderer from '../components/MarkdownRenderer';
import { useTheme } from '../lib/themeContext';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';

interface Props {
	title: string;
	markdown: string;
	onChange: (next: string) => void;
	onTitleChange: (next: string) => void;
	/** Called on explicit save (Ctrl+S / toolbar). */
	onSave: () => void;
	readOnly?: boolean;
}

/**
 * How the source and the preview share the screen.
 *
 *  - `split` : source left, preview right (the default while writing)
 *  - `edit`  : source only
 *  - `preview`: preview only (reading mode)
 *
 * Three explicit modes replace the old boolean toggle, which only offered
 * "hide the preview" and left no way to read a document without the editor.
 */
type ViewMode = 'split' | 'edit' | 'preview';

interface Heading {
	level: number;
	text: string;
	/** index among the rendered headings, used to scroll to it */
	index: number;
}

/** Pull `#`/`##`/`###` headings out of the source, skipping fenced code blocks. */
function extractHeadings(src: string): Heading[] {
	const out: Heading[] = [];
	let inFence = false;
	let i = 0;
	for (const line of src.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = /^(#{1,6})\s+(.*)$/.exec(line);
		if (!m) continue;
		const text = m[2].replace(/[*_`~]/g, '').trim();
		if (!text) continue;
		out.push({ level: m[1].length, text, index: i++ });
	}
	return out;
}

export default function MarkdownEditor({
	title,
	markdown,
	onChange,
	onTitleChange,
	onSave,
	readOnly = false,
}: Props) {
	const theme = useTheme();
	const [mode, setMode] = useState<ViewMode>(readOnly ? 'preview' : 'split');
	const [tocOpen, setTocOpen] = useState(true);
	const textRef = useRef<HTMLTextAreaElement | null>(null);
	const previewRef = useRef<HTMLDivElement | null>(null);

	// Ctrl+S saves; Tab inserts two spaces instead of moving focus out
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				onSave();
				return;
			}
			if (e.key === 'Tab' && document.activeElement === textRef.current) {
				e.preventDefault();
				const el = textRef.current!;
				const start = el.selectionStart;
				const end = el.selectionEnd;
				const next = markdown.slice(0, start) + '  ' + markdown.slice(end);
				onChange(next);
				requestAnimationFrame(() => {
					el.selectionStart = el.selectionEnd = start + 2;
				});
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [markdown, onChange, onSave]);

	const stats = useMemo(() => {
		const chars = markdown.length;
		const lines = markdown.split('\n').length;
		return { chars, lines };
	}, [markdown]);

	const headings = useMemo(() => extractHeadings(markdown), [markdown]);

	/**
	 * Scroll to the Nth heading in the rendered preview.
	 *
	 * Querying the DOM (rather than assigning ids during render) keeps
	 * MarkdownRenderer untouched and works for headings the renderer creates
	 * itself, including ones nested inside blockquotes.
	 */
	const jumpTo = useCallback((index: number) => {
		const root = previewRef.current;
		if (!root) return;
		const els = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
		const el = els[index];
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}, []);

	const download = useCallback(() => {
		const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${title || '未命名'}.md`;
		a.click();
		URL.revokeObjectURL(url);
		toast('已导出 Markdown', 'success');
	}, [markdown, title]);

	const showSource = mode !== 'preview';
	const showPreview = mode !== 'edit';

	return (
		<div className="md-editor">
			<header className="editor__bar">
				<div className="editor__left">
					<button className="icon-btn" onClick={() => navigate('/')} title="返回首页">
						<ChevronLeft size={17} strokeWidth={2} />
					</button>
					<FileText size={15} strokeWidth={1.9} className="md-editor__badge" />
					<input
						className="editor__title"
						value={title}
						onChange={(e) => onTitleChange(e.target.value)}
						placeholder="未命名文档"
						disabled={readOnly}
					/>
					<span className="save-state">
						{stats.chars} 字 · {stats.lines} 行
					</span>
				</div>
				<div className="editor__right">
					{/* view mode: three explicit choices, not a single toggle */}
					<div className="md-viewtabs">
						<button
							className={`md-viewtab${mode === 'edit' ? ' is-active' : ''}`}
							onClick={() => setMode('edit')}
							title="只显示源码"
						>
							<PenLine size={14} strokeWidth={2} />
							编辑
						</button>
						<button
							className={`md-viewtab${mode === 'split' ? ' is-active' : ''}`}
							onClick={() => setMode('split')}
							title="源码与预览并排"
						>
							<SquareSplitHorizontal size={14} strokeWidth={2} />
							分栏
						</button>
						<button
							className={`md-viewtab${mode === 'preview' ? ' is-active' : ''}`}
							onClick={() => setMode('preview')}
							title="只显示渲染后的文档"
						>
							<Eye size={14} strokeWidth={2} />
							预览
						</button>
					</div>

					{headings.length ? (
						<button
							className={`btn-ghost btn-icon-text${tocOpen ? ' is-on' : ''}`}
							onClick={() => setTocOpen((v) => !v)}
							title="显示 / 隐藏目录"
						>
							<List size={15} strokeWidth={1.9} />
							目录
						</button>
					) : null}

					<button className="btn-ghost btn-icon-text" onClick={download}>
						<Download size={15} strokeWidth={1.9} />
						导出 .md
					</button>
				</div>
			</header>

			<div className={`md-editor__body md-mode-${mode}`} style={{ background: theme.canvas }}>
				{showSource ? (
					<textarea
						ref={textRef}
						className="md-editor__source"
						value={markdown}
						onChange={(e) => onChange(e.target.value)}
						spellCheck={false}
						readOnly={readOnly}
						placeholder="在这里写 Markdown…"
					/>
				) : null}

				{showPreview ? (
					<div className="md-editor__previewwrap">
						{/* table of contents */}
						{headings.length && tocOpen ? (
							<nav className="md-toc">
								<div className="md-toc__title">目录</div>
								{headings.map((h) => (
									<button
										key={`${h.index}-${h.text}`}
										className={`md-toc__item md-toc__item--l${h.level}`}
										onClick={() => jumpTo(h.index)}
										title={h.text}
									>
										{h.text}
									</button>
								))}
							</nav>
						) : null}
						<div className="md-editor__preview" ref={previewRef}>
							<div className="md-label md-editor__rendered">
								<MarkdownRenderer source={markdown || '*（空文档）*'} />
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
