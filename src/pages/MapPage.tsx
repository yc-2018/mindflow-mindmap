import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import Editor from './Editor';
import MarkdownEditor from './MarkdownEditor';
import DrawioEditor from './DrawioEditor';
import { api, ApiError } from '../lib/api';
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
				try {
					await api.updateMap(mapId, { title: snap.title, data: serializeDoc(doc) });
				} catch {
					toast('保存失败', 'error');
				}
			};

			if (immediate) await run();
			else saveTimer.current = window.setTimeout(run, 900);
		},
		[mapId, readOnly],
	);

	const changeMarkdown = useCallback(
		(next: string) => {
			setMarkdown(next);
			void persist();
		},
		[persist],
	);

	const changeXml = useCallback(
		(next: string) => {
			setDrawioXml(next);
			void persist();
		},
		[persist],
	);

	const changeTitle = useCallback(
		(next: string) => {
			setTitle(next);
			void persist();
		},
		[persist],
	);

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
