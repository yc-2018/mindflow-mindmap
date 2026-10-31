import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Download } from 'lucide-react';

import DrawioLogo from '../components/DrawioLogo';

import { navigate } from '../lib/router';
import { toast } from '../lib/toast';

interface Props {
	title: string;
	xml: string;
	onChange: (next: string) => void;
	onTitleChange: (next: string) => void;
	onSave: () => void;
	/** One-line save status for the header (「已自动保存 09:52:11」…). */
	saveHint?: string | null;
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
 *
 * UI note: `ui=min`, and the sidebar toggles are draw.io's OWN buttons.
 *
 * draw.io's menubar already has two working toggles: 「形状」 (left shapes panel)
 * and 「格式」 (right format panel). Clicking one closes its panel, clicking it
 * again brings it back — verified by clicking each twice and watching the
 * panel width go 212 → 0 → 212.
 *
 * The problem was purely DISCOVERABILITY: those buttons are drawn as plain
 * bordered boxes with a thin double outline, so they read as decorative labels
 * rather than as switches. Users closed the panel with the X inside the panel
 * and then could not find how to bring it back.
 *
 * The fix is therefore visual, not functional: a small stylesheet injected into
 * the frame turns those two buttons into obvious pill toggles and dims them
 * when their panel is hidden.
 *
 * (An earlier attempt forced `display`/`width` on the panel containers from the
 * parent page. That OVERRODE draw.io's own toggle logic and left the panels
 * stuck — the exact symptom being reported. Do not do that again.)
 */
const DRAWIO_BASE = '/drawio/';

const EMBED_URL = `${DRAWIO_BASE}?embed=1&ui=min&spin=1&proto=json&noSaveBtn=1&noExitBtn=1&libraries=1&lang=zh`;

/**
 * Stylesheet injected into the draw.io frame to make the two panel toggles
 * legible as switches.
 *
 * Same-origin (`/drawio/` is on our domain), so we may touch the frame DOM.
 * Everything is scoped to the menubar buttons by their `title`, so no other
 * draw.io UI is affected.
 */
const TOGGLE_STYLES = `
	/* the two panel toggles: give them a switch look instead of a plain box */
	.geMenubarContainer .geButton[title="形状"],
	.geMenubarContainer .geButton[title^="格式"] {
		display: inline-flex !important;
		align-items: center;
		gap: 4px;
		padding: 2px 9px 2px 7px !important;
		margin-right: 4px;
		border: 1px solid #c7d2fe !important;
		border-radius: 13px !important;
		background: #eef2ff !important;
		color: #4338ca !important;
		font-weight: 600;
		line-height: 20px;
		position: relative;
	}
	.geMenubarContainer .geButton[title="形状"]:hover,
	.geMenubarContainer .geButton[title^="格式"]:hover {
		background: #e0e7ff !important;
		border-color: #a5b4fc !important;
	}
	/* a leading dot that reads as an on/off indicator */
	.geMenubarContainer .geButton[title="形状"]::before,
	.geMenubarContainer .geButton[title^="格式"]::before {
		content: "";
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #4338ca;
		flex: 0 0 auto;
	}
	/* dim the button when its panel is currently closed */
	.geMenubarContainer .geButton[title="形状"].is-panel-off,
	.geMenubarContainer .geButton[title^="格式"].is-panel-off {
		background: #f8fafc !important;
		border-color: #e2e8f0 !important;
		color: #94a3b8 !important;
	}
	.geMenubarContainer .geButton[title="形状"].is-panel-off::before,
	.geMenubarContainer .geButton[title^="格式"].is-panel-off::before {
		background: #cbd5e1;
	}
`;

/**
 * Install the toggle styling and keep each button's dim state in sync with its
 * panel.
 *
 * Polling (instead of hooking draw.io's internal events) is deliberate: the
 * panel widths are driven by draw.io's own code, and a light interval is the
 * least invasive way to mirror that into the button styling. It stops as soon
 * as the frame is gone.
 */
function installToggleStyles(iframe: HTMLIFrameElement | null): () => void {
	const doc = iframe?.contentDocument;
	if (!doc) return () => undefined;

	// inject once
	const STYLE_ID = 'mindflow-toggle-styles';
	if (!doc.getElementById(STYLE_ID)) {
		const style = doc.createElement('style');
		style.id = STYLE_ID;
		style.textContent = TOGGLE_STYLES;
		doc.head?.appendChild(style);
	}

	const findButtons = () => {
		const all = Array.from(doc.querySelectorAll<HTMLElement>('.geMenubarContainer .geButton'));
		return {
			shape: all.find((b) => b.getAttribute('title') === '形状') ?? null,
			format: all.find((b) => (b.getAttribute('title') || '').indexOf('格式') === 0) ?? null,
		};
	};

	const sync = () => {
		const left = doc.querySelector<HTMLElement>('.geSidebarContainer');
		const right = doc.querySelector<HTMLElement>('.geFormatContainer');
		const { shape, format } = findButtons();
		// a panel counts as "off" when its width collapsed to (almost) nothing
		const leftOff = left ? left.getBoundingClientRect().width < 10 : true;
		const rightOff = right ? right.getBoundingClientRect().width < 10 : true;
		shape?.classList.toggle('is-panel-off', leftOff);
		format?.classList.toggle('is-panel-off', rightOff);
	};

	sync();
	const timer = window.setInterval(sync, 400);
	return () => window.clearInterval(timer);
}

export default function DrawioEditor({
	title,
	xml,
	onChange,
	onTitleChange,
	onSave,
	saveHint,
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
					/**
					 * Style draw.io's own 「形状」/「格式」 buttons so they read as
					 * panel switches. Delayed slightly because the menubar is built
					 * after `load` settles.
					 */
					window.setTimeout(() => installToggleStyles(frameRef.current), 600);
					break;
				case 'save':
				case 'autosave': {
					const next = typeof msg.xml === 'string' ? msg.xml : null;
					if (next && next !== latestXml.current) onChange(next);
					/**
					 * Acknowledge with draw.io's own status popup.
					 *
					 * `save` is the user pressing 保存并退出 (or Ctrl+S inside the
					 * frame); replying with an EMPTY message — which is what we
					 * used to do for both events — shows nothing at all, so the
					 * click looked dead ("点击好像并没有什么反应"). An explicit save now
					 * pops 「已保存」 and persists immediately; the silent autosave
					 * keeps the empty message and the normal debounced write.
					 */
					const explicit = msg.event === 'save';
					post({ action: 'status', message: explicit ? '已保存' : '', modified: false });
					if (explicit) onSave();
					break;
				}
				case 'exit': {
					// 保存并退出 in some builds fires `exit` after `save`; confirm so
					// the frame clears its dirty marker. We stay on the page.
					post({ action: 'status', message: '已保存', modified: false });
					toast('已保存', 'success');
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
	}, [onChange, post, title, onSave]);

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
					<DrawioLogo size={15} className="md-editor__badge" />
					<input
						className="editor__title"
						value={title}
						onChange={(e) => onTitleChange(e.target.value)}
						placeholder="未命名图表"
						disabled={readOnly}
					/>
					<span className={`save-state${saveHint === '保存失败，请重试' ? ' save-state--error' : ''}`}>
						{!ready ? '加载中…' : (saveHint ?? '自动保存已开启')}
					</span>
				</div>
				<div className="editor__right">
					{/*
					  The panel toggles are draw.io's own menubar buttons (形状 / 格式),
					  restyled by `installToggleStyles` to look like switches. We do NOT
					  add our own buttons: forcing the panel widths from here overrode
					  draw.io's toggle logic and left the panels stuck closed.
					*/}
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
