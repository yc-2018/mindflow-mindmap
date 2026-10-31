import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import Editor from './Editor';
import MarkdownEditor from './MarkdownEditor';
import DrawioEditor from './DrawioEditor';
import { api, ApiError } from '../lib/api';
import { getAutoSave, useAutoSave } from '../lib/autoSave';
import { useUnsavedGuard } from '../lib/leaveGuard';
import { parseDoc, serializeDoc, docKind, type DocKind } from '../lib/types';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';
import { Toaster } from '../lib/toast';

interface Props {
	mapId: string;
	readOnly?: boolean;
}

/**
 * Entry point for a map page.
 *
 * Loads the document ONCE, decides its kind, then mounts the matching editor:
 *  - `mind`   → the React Flow mind map (Editor)
 *  - `md`     → Markdown source + live preview
 *  - `drawio` → the official draw.io embed
 *
 * Keeping the load here (instead of inside Editor) means a markdown or drawio
 * document never pays for React Flow's setup, and the kind is known before any
 * editor mounts.
 */
export default function MapPage({ mapId, readOnly = false }: Props) {
	const [kind, setKind] = useState<DocKind | null>(null);
	const [title, setTitle] = useState('');
	const [markdown, setMarkdown] = useState('');
	const [drawioXml, setDrawioXml] = useState('');
	const [loading, setLoading] = useState(true);

	const saveTimer = useRef<number | null>(null);
	const latest = useRef({ title: '', markdown: '', drawioXml: '', kind: 'mind' as DocKind });
	latest.current = { title, markdown, drawioXml, kind: kind ?? 'mind' };

	/**
	 * Visible save state for the md / drawio editors.
	 *
	 * Their autosave was completely silent, so users could not tell whether
	 * anything was being stored ("没有地方显示自动保存"). The mind map editor
	 * already has its own indicator; these two now share this one.
	 */
	type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
	const [saveState, setSaveState] = useState<SaveState>('idle');
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		let alive = true;
		api
			.getMap(mapId)
			.then(({ map }) => {
				if (!alive) return;
				const doc = parseDoc(map.data);
				const k = docKind(doc);
				setTitle(map.title);
				setKind(k);
				if (k === 'md') setMarkdown(doc.markdown ?? '');
				else if (k === 'drawio') setDrawioXml(doc.drawioXml ?? '');
			})
			.catch((err) => {
				if (!alive) return;
				if (err instanceof ApiError && err.status === 404) {
					toast('文档不存在', 'error');
					navigate('/');
					return;
				}
				toast('加载失败', 'error');
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [mapId]);

	/**
	 * Persist the document.
	 *
	 * Only md / drawio use this path — the mind map keeps its own editor-local
	 * autosave, so passing it through here would duplicate the write.
	 *
	 * `immediate` (Ctrl+S / draw.io 保存按钮) writes now and confirms with a
	 * toast; the debounced path just quietly stores after 900ms of idle.
	 */
	const persist = useCallback(
		async (immediate = false) => {
			if (readOnly) return;
			if (saveTimer.current) window.clearTimeout(saveTimer.current);

			const run = async () => {
				const snap = latest.current;
				const doc = {
					kind: snap.kind,
					nodes: [],
					edges: [],
					...(snap.kind === 'md' ? { markdown: snap.markdown } : {}),
					...(snap.kind === 'drawio' ? { drawioXml: snap.drawioXml } : {}),
				};
				setSaveState('saving');
				try {
					await api.updateMap(mapId, { title: snap.title, data: serializeDoc(doc) });
					setSaveState('saved');
					setSavedAt(Date.now());
					if (immediate) toast('已保存', 'success');
				} catch {
					setSaveState('error');
					toast('保存失败', 'error');
				}
			};

			if (immediate) await run();
			else saveTimer.current = window.setTimeout(run, 900);
		},
		[mapId, readOnly],
	);

	/**
	 * Edit handlers.
	 *
	 * They write the ref IMMEDIATELY (not just on re-render), so an explicit
	 * save fired in the same event — e.g. draw.io's 保存并退出 → autosave
	 * message → persist — never stores a stale value.
	 *
	 * With auto-save switched off the change still marks the document dirty,
	 * but nothing is scheduled; only the 保存 button / Ctrl+S writes.
	 */
	const changeMarkdown = useCallback(
		(next: string) => {
			latest.current.markdown = next;
			setMarkdown(next);
			setSaveState('dirty');
			if (getAutoSave()) void persist();
		},
		[persist],
	);

	const changeXml = useCallback(
		(next: string) => {
			latest.current.drawioXml = next;
			setDrawioXml(next);
			setSaveState('dirty');
			/**
			 * draw.io's own autosave messages land HERE constantly while typing;
			 * they must not resurrect a save that the user deliberately turned
			 * off — hence the same gate. An EXPLICIT draw.io 保存事件 (the save
			 * message kind) still comes through DrawioEditor's onSave.
			 */
			if (getAutoSave()) void persist();
		},
		[persist],
	);

	const changeTitle = useCallback(
		(next: string) => {
			latest.current.title = next;
			setTitle(next);
			setSaveState('dirty');
			if (getAutoSave()) void persist();
		},
		[persist],
	);

	const autoSave = useAutoSave();
	const saveStateRef = useRef(saveState);
	saveStateRef.current = saveState;

	/** Re-enabling auto-save flushes whatever manual mode left pending. */
	useEffect(() => {
		if (autoSave && (saveStateRef.current === 'dirty' || saveStateRef.current === 'error')) persist();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [autoSave]);

	/** Browser close/reload with unsaved changes → the native "leave once" prompt. */
	const unsavedRef = useRef(false);
	unsavedRef.current = saveState === 'dirty' || saveState === 'error' || saveState === 'saving';
	useUnsavedGuard(unsavedRef);

	const dirty = saveState === 'dirty' || saveState === 'error';

	/** One-line save indicator shared by the md / drawio editors. */
	const saveHint = readOnly
		? null
		: saveState === 'saving'
			? '正在保存…'
			: saveState === 'saved' && savedAt
				? `${autoSave ? '已自动保存' : '已保存'} ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
				: saveState === 'error'
					? '保存失败，请重试'
					: saveState === 'dirty'
						? '有未保存的更改'
						: autoSave
							? null
							: '手动保存模式';

	if (loading || !kind) {
		return (
			<div className="boot">
				<div className="spinner" />
			</div>
		);
	}

	if (kind === 'md') {
		return (
			<>
				<MarkdownEditor
					title={title}
					markdown={markdown}
					onChange={changeMarkdown}
					onTitleChange={changeTitle}
					onSave={() => void persist(true)}
					saveHint={saveHint}
					dirty={dirty}
					readOnly={readOnly}
				/>
				<Toaster />
			</>
		);
	}

	if (kind === 'drawio') {
		return (
			<>
				<DrawioEditor
					title={title}
					xml={drawioXml}
					onChange={changeXml}
					onTitleChange={changeTitle}
					onSave={() => void persist(true)}
					saveHint={saveHint}
					dirty={dirty}
					readOnly={readOnly}
				/>
				<Toaster />
			</>
		);
	}

	// mind map: hand over to the existing editor, which owns its own autosave
	return (
		<ReactFlowProvider>
			<Editor mapId={mapId} readOnly={readOnly} />
		</ReactFlowProvider>
	);
}
