import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Download, PenLine } from 'lucide-react';

import { navigate } from '../lib/router';
import { toast } from '../lib/toast';

interface Props {
	title: string;
	xml: string;
	onChange: (next: string) => void;
	onTitleChange: (next: string) => void;
	onSave: () => void;
	readOnly?: boolean;
}

/**
 * draw.io editor, embedded via a SELF-HOSTED copy of the official webapp.
 *
 * Why self-hosted: `embed.diagrams.net` refuses to be framed from a third-party
 * origin — it answers an iframe request with HTTP 403 and an empty body (its
 * anti-framing policy), so the editor could never load. The official `draw.war`
 * release served from our own domain has no such restriction, and it is still
 * the genuine draw.io UI.
 *
 * The embed speaks a postMessage protocol:
 *   us  -> it : `load` (send the XML), `export` (ask for the current XML)
 *   it  -> us : `init` (ready), `save`/`autosave` (here is the XML), `export`
 *
 * We keep the XML in the document (`drawioXml`), so the same value powers the
 * editor, export, import and the read-only share view.
 *
 * Path note: uses `/drawio/` (with the trailing slash) rather than
 * `/drawio/index.html` — Cloudflare's asset layer answers the explicit `.html`
 * path with a 307 to the directory form, and following that inside an iframe
 * costs an extra round trip.
 *
 * Language note: `lang=zh` is required. draw.io falls back to English unless a
 * language is requested explicitly, and the translations live in
 * `resources/dia_<lang>.txt` — those files have to be served alongside the
 * webapp, otherwise the UI stays English no matter what `lang` says.
 */
const DRAWIO_BASE = '/drawio/';

const EMBED_URL = `${DRAWIO_BASE}?embed=1&ui=min&spin=1&proto=json&noSaveBtn=1&noExitBtn=1&libraries=1&lang=zh`;

export default function DrawioEditor({
	title,
	xml,
	onChange,
	onTitleChange,
	onSave,
	readOnly = false,
}: Props) {
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const [ready, setReady] = useState(false);
	// the latest XML, so the message handler always sees the current value
	const latestXml = useRef(xml);
	latestXml.current = xml;

	/** Post a message to the iframe once it exists. */
	const post = useCallback((msg: Record<string, unknown>) => {
		frameRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');
	}, []);

	useEffect(() => {
		const onMessage = (ev: MessageEvent) => {
			// the embed posts JSON strings
			let msg: Record<string, unknown>;
			try {
				msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
			} catch {
				return;
			}
			if (!msg || typeof msg !== 'object') return;

			switch (msg.event) {
				case 'init':
					setReady(true);
					// hand the stored diagram to the editor
					post({ action: 'load', xml: latestXml.current, autosave: 1 });
					break;
				case 'save':
				case 'autosave': {
					const next = typeof msg.xml === 'string' ? msg.xml : null;
					if (next && next !== latestXml.current) onChange(next);
					// acknowledge, otherwise the embed keeps the "unsaved" state
					post({ action: 'status', message: '', modified: false });
					break;
				}
				case 'export': {
					const next = typeof msg.xml === 'string' ? msg.xml : null;
					if (next) downloadXml(next, title);
					break;
				}
				default:
					break;
			}
		};

		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [onChange, post, title]);

	// Ctrl+S asks the embed for its current XML, then persists
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				post({ action: 'export', format: 'xml' });
				onSave();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onSave, post]);

	return (
		<div className="drawio-editor">
			<header className="editor__bar">
				<div className="editor__left">
					<button className="icon-btn" onClick={() => navigate('/')} title="返回首页">
						<ChevronLeft size={17} strokeWidth={2} />
					</button>
					<PenLine size={15} strokeWidth={1.9} className="md-editor__badge" />
					<input
						className="editor__title"
						value={title}
						onChange={(e) => onTitleChange(e.target.value)}
						placeholder="未命名图表"
						disabled={readOnly}
					/>
					<span className="save-state">{ready ? '已连接 draw.io' : '加载中…'}</span>
				</div>
				<div className="editor__right">
					<button
						className="btn-ghost btn-icon-text"
						onClick={() => post({ action: 'export', format: 'xml' })}
						title="导出 .drawio 文件"
					>
						<Download size={15} strokeWidth={1.9} />
						导出 .drawio
					</button>
				</div>
			</header>

			<div className="drawio-editor__body">
				{/*
				  No `sandbox` attribute on purpose.

				  The embed authenticates itself by postMessage-ing an `init` event and
				  waiting for us to reply. With `sandbox` set (even including
				  allow-same-origin) the browser treats the frame as an opaque origin, so
				  that handshake never completes and the editor sits on "加载中…"
				  forever. diagrams.net is the official first-party host, so loading it
				  unsandboxed is the supported integration path.
				*/}
				<iframe
					ref={frameRef}
					className="drawio-editor__frame"
					src={EMBED_URL}
					title="draw.io editor"
				/>
			</div>
		</div>
	);
}

/** Save the diagram as a `.drawio` file (same XML, with a helpful filename). */
function downloadXml(xml: string, title: string) {
	const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${title || '未命名'}.drawio`;
	a.click();
	URL.revokeObjectURL(url);
	toast('已导出 .drawio', 'success');
}
