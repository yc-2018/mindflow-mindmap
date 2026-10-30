import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Download, Eye, EyeOff, FileText } from 'lucide-react';

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
 * Markdown document editor.
 *
 * Left: the raw Markdown source. Right: a live preview rendered with the SAME
 * renderer the mind map nodes use, so `==highlight==`, tables and code blocks
 * behave identically in both document kinds.
 *
 * The source is kept in the document (`markdown` field), which means import,
 * export and sharing all work without a second storage format.
 */
export default function MarkdownEditor({
	title,
	markdown,
	onChange,
	onTitleChange,
	onSave,
	readOnly = false,
}: Props) {
	const theme = useTheme();
	const [showPreview, setShowPreview] = useState(true);
	const textRef = useRef<HTMLTextAreaElement | null>(null);

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
		const words = markdown.trim() ? markdown.trim().split(/\s+/).length : 0;
		return { chars, lines, words };
	}, [markdown]);

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
					<span className="save-state">{stats.chars} 字 · {stats.lines} 行</span>
				</div>
				<div className="editor__right">
					<button
						className="btn-ghost btn-icon-text"
						onClick={() => setShowPreview((v) => !v)}
						title={showPreview ? '隐藏预览' : '显示预览'}
					>
						{showPreview ? <EyeOff size={15} strokeWidth={1.9} /> : <Eye size={15} strokeWidth={1.9} />}
						{showPreview ? '隐藏预览' : '显示预览'}
					</button>
					<button className="btn-ghost btn-icon-text" onClick={download}>
						<Download size={15} strokeWidth={1.9} />
						导出 .md
					</button>
				</div>
			</header>

			<div className={`md-editor__body${showPreview ? ' has-preview' : ''}`} style={{ background: theme.canvas }}>
				<textarea
					ref={textRef}
					className="md-editor__source"
					value={markdown}
					onChange={(e) => onChange(e.target.value)}
					spellCheck={false}
					readOnly={readOnly}
					placeholder="在这里写 Markdown…"
				/>
				{showPreview ? (
					<div className="md-editor__preview">
						<div className="md-label md-editor__rendered">
							<MarkdownRenderer source={markdown || '*（空文档）*'} />
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
