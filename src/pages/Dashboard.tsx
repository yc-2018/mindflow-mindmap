import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ArrowDownWideNarrow,
	ChevronDown,
	Download,
	FileText,
	FolderOpen,
	Link2,
	Lock,
	LogOut,
	Map as MapIcon,
	Network,
	PenLine,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Share2,
	Trash2,
	Upload,
	Users,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';

import Thumbnail from '../components/Thumbnail';
import { Logo } from '../components/Logo';
import { api, ApiError, type MapSummary, type User } from '../lib/api';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';
import { parseDoc, serializeDoc, starterDocOf, docKind, type MapDoc, type MindNode, type DocKind } from '../lib/types';
import { layoutTree } from '../lib/layout';
import { importDoc } from '../lib/import';
import { uid } from '../lib/uid';

interface DashboardProps {
	user: User;
	onLogout: () => void;
}

/**
 * Starter document for a newly created map.
 *
 * `kind` decides the shape: a mind map gets a centred root, a markdown note gets
 * a small template, and a draw.io diagram gets a one-node page.
 */
function starterDoc(kind: DocKind = 'mind'): string {
	if (kind !== 'mind') return serializeDoc(starterDocOf(kind));
	const root: MindNode = {
		id: uid(),
		type: 'mind',
		position: { x: 0, y: 0 },
		data: { label: '中心主题', tone: 'root' },
	};
	const doc: MapDoc = { nodes: layoutTree([root], []), edges: [] };
	return serializeDoc(doc);
}

function fmtDate(ts: number): string {
	const d = new Date(ts);
	const diff = Date.now() - ts;
	if (diff < 60_000) return '刚刚';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Dashboard({ user, onLogout }: DashboardProps) {
	const [maps, setMaps] = useState<MapSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [creating, setCreating] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<MapSummary | null>(null);
	const [shareFor, setShareFor] = useState<MapSummary | null>(null);
	const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
	const [sort, setSort] = useState<'updated' | 'created' | 'title'>('updated');
	const [query, setQuery] = useState('');
	const [importing, setImporting] = useState(false);
	const [newMenuOpen, setNewMenuOpen] = useState(false);
	const fileRef = useRef<HTMLInputElement | null>(null);

	const load = useCallback(async () => {
		try {
			const { maps: list } = await api.listMaps();
			setMaps(list);
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onLogout();
				return;
			}
			toast('加载列表失败', 'error');
		} finally {
			setLoading(false);
		}
	}, [onLogout]);

	useEffect(() => {
		void load();
	}, [load]);

	/**
	 * Create a new document.
	 *
	 * The kind is picked from the small menu next to the button, so a user can
	 * start a mind map, a Markdown note or a draw.io diagram without leaving the
	 * dashboard.
	 */
	const createMap = useCallback(
		async (kind: DocKind = 'mind') => {
			if (creating) return;
			setCreating(true);
			setNewMenuOpen(false);
			try {
				const titles: Record<DocKind, string> = {
					mind: '未命名导图',
					md: '未命名文档',
					drawio: '未命名图表',
				};
				const { map } = await api.createMap(titles[kind], starterDoc(kind));
				navigate(`/map/${map.id}`);
			} catch {
				toast('创建失败', 'error');
			} finally {
				setCreating(false);
			}
		},
		[creating],
	);

	const doDelete = useCallback(async (m: MapSummary) => {
		try {
			await api.deleteMap(m.id);
			setMaps((prev) => prev.filter((x) => x.id !== m.id));
			toast('已删除', 'success');
		} catch {
			toast('删除失败', 'error');
		} finally {
			setConfirmDelete(null);
		}
	}, []);

	const openShare = useCallback(async (m: MapSummary) => {
		try {
			const { shareToken } = await api.setShare(m.id, true);
			const updated = { ...m, shareToken };
			setMaps((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
			setShareFor(updated);
			const url = `${window.location.origin}/s/${shareToken}`;
			await navigator.clipboard.writeText(url).catch(() => undefined);
			toast('分享链接已复制', 'success');
		} catch {
			toast('操作失败', 'error');
		}
	}, []);

	const closeShare = useCallback(async (m: MapSummary) => {
		try {
			await api.setShare(m.id, false);
			setMaps((prev) => prev.map((x) => (x.id === m.id ? { ...x, shareToken: null } : x)));
			setShareFor(null);
			toast('已关闭分享', 'success');
		} catch {
			toast('操作失败', 'error');
		}
	}, []);

	/**
	 * Rotate the share link.
	 *
	 * Same operation the editor offers: a share URL is a bearer token, so the only
	 * way to revoke a leaked one is to issue a fresh token. The old link dies
	 * immediately.
	 */
	const resetShare = useCallback(async (m: MapSummary) => {
		try {
			const { shareToken } = await api.resetShare(m.id);
			const updated = { ...m, shareToken };
			setMaps((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
			setShareFor(updated);
			if (shareToken) {
				const url = `${window.location.origin}/s/${shareToken}`;
				await navigator.clipboard.writeText(url).catch(() => undefined);
				toast('已生成新链接，旧链接已失效', 'success');
			}
		} catch {
			toast('操作失败', 'error');
		}
	}, []);

	const rename = useCallback(async () => {
		if (!renaming) return;
		const title = renaming.title.trim() || '未命名导图';
		try {
			await api.updateMap(renaming.id, { title });
			setMaps((prev) => prev.map((x) => (x.id === renaming.id ? { ...x, title } : x)));
			setRenaming(null);
			toast('已重命名', 'success');
		} catch {
			toast('重命名失败', 'error');
		}
	}, [renaming]);

	/**
	 * Export a document in its NATIVE format.
	 *
	 *  - mind map  → `.json` (our own round-trippable format)
	 *  - markdown  → `.md`
	 *  - drawio    → `.drawio` (the raw `<mxfile>` XML)
	 */
	const download = useCallback(async (m: MapSummary) => {
		const doc = parseDoc(m.data);
		const kind = docKind(doc);
		const base = m.title || '未命名';

		let blob: Blob;
		let filename: string;
		let label: string;
		if (kind === 'md') {
			blob = new Blob([doc.markdown ?? ''], { type: 'text/markdown;charset=utf-8' });
			filename = `${base}.md`;
			label = 'Markdown';
		} else if (kind === 'drawio') {
			blob = new Blob([doc.drawioXml ?? ''], { type: 'application/xml;charset=utf-8' });
			filename = `${base}.drawio`;
			label = '.drawio';
		} else {
			blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
			filename = `${base}.json`;
			label = 'JSON';
		}

		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
		toast(`已导出 ${label}`, 'success');
	}, []);

	/**
	 * Import a file as a NEW document.
	 *
	 * Supported inputs, decided by extension/content:
	 *  - `.json`  → MindFlow's own format or a ProcessOn export (mind map)
	 *  - `.md` / `.markdown` / `.txt` → Markdown note
	 *  - `.drawio` / `.xml` → draw.io diagram
	 */
	const importFile = useCallback(
		async (file: File) => {
			if (importing) return;
			setImporting(true);
			try {
				const text = await file.text();
				const name = file.name.replace(/\.(json|md|markdown|txt|drawio|xml)$/i, '');
				const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

				// --- draw.io: raw XML ---
				if (ext === 'drawio' || (ext === 'xml' && text.includes('<mxfile'))) {
					const doc: MapDoc = { kind: 'drawio', nodes: [], edges: [], drawioXml: text };
					const created = await api.createMap((name || '导入的图表').slice(0, 80), serializeDoc(doc));
					setMaps((prev) => [created.map, ...prev]);
					toast('已导入 draw.io 图表', 'success');
					return;
				}

				// --- markdown: plain text ---
				if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
					const doc: MapDoc = { kind: 'md', nodes: [], edges: [], markdown: text };
					const created = await api.createMap((name || '导入的文档').slice(0, 80), serializeDoc(doc));
					setMaps((prev) => [created.map, ...prev]);
					toast('已导入 Markdown 文档', 'success');
					return;
				}

				// --- JSON: our format or ProcessOn ---
				const result = importDoc(text);
				if (!result.doc.nodes.length) {
					toast('文件里没有节点', 'error');
					return;
				}

				const parsedTitle = (() => {
					try {
						const raw = JSON.parse(text) as { title?: string };
						return typeof raw?.title === 'string' ? raw.title.trim() : '';
					} catch {
						return '';
					}
				})();
				const title = (parsedTitle || name || '导入的导图').slice(0, 80);

				const created = await api.createMap(title, serializeDoc(result.doc));
				setMaps((prev) => [created.map, ...prev]);

				const fmt = result.format === 'processon' ? 'ProcessOn' : 'MindFlow';
				const extra = result.warnings.length ? `（${result.warnings[0]}）` : '';
				toast(`已导入 ${result.doc.nodes.length} 个节点 · ${fmt} 格式${extra}`, 'success');
			} catch (err) {
				toast(err instanceof Error ? err.message : '导入失败', 'error');
			} finally {
				setImporting(false);
				if (fileRef.current) fileRef.current.value = '';
			}
		},
		[importing],
	);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		const list = q ? maps.filter((m) => m.title.toLowerCase().includes(q)) : maps;
		return [...list].sort((a, b) => {
			if (sort === 'title') return a.title.localeCompare(b.title, 'zh-CN');
			if (sort === 'created') return b.createdAt - a.createdAt;
			return b.updatedAt - a.updatedAt;
		});
	}, [maps, sort, query]);

	return (
		<div className="dash">
			<header className="dash__bar">
				<div className="dash__brand">
					<div className="dash__logo">
						<Logo size={26} />
					</div>
					<span className="dash__name">MindFlow</span>
				</div>

				<div className="dash__actions">
					{user.role === 'admin' ? (
						<button className="btn-ghost btn-icon-text" onClick={() => navigate('/admin')}>
							<Users size={15} strokeWidth={1.9} />
							用户管理
						</button>
					) : null}
					<div className="dash__user">
						<span className="dash__avatar">{user.name.slice(0, 1).toUpperCase()}</span>
						<span className="dash__uname">{user.name}</span>
					</div>
					<button className="btn-ghost btn-icon-text" onClick={onLogout}>
						<LogOut size={15} strokeWidth={1.9} />
						退出
					</button>
				</div>
			</header>

			<main className="dash__main">
				<div className="dash__head">
					<h1>我的文件</h1>

					{/* New: a split control so the user picks the document kind. */}
					<div className="new-split">
						<button className="btn-primary btn-new" onClick={() => void createMap('mind')} disabled={creating}>
							<Plus size={17} strokeWidth={2.2} />
							新建
						</button>
						<button
							className="btn-primary new-split__caret"
							onClick={() => setNewMenuOpen((v) => !v)}
							disabled={creating}
							title="选择新建类型"
							aria-label="选择新建类型"
						>
							<ChevronDown size={15} strokeWidth={2.2} />
						</button>
						{newMenuOpen ? (
							<div className="new-menu">
								<button className="new-menu__item" onClick={() => void createMap('mind')}>
									<Network size={15} strokeWidth={1.9} />
									<span>
										<b>思维导图</b>
										<small>React Flow 画布</small>
									</span>
								</button>
								<button className="new-menu__item" onClick={() => void createMap('md')}>
									<FileText size={15} strokeWidth={1.9} />
									<span>
										<b>Markdown 文档</b>
										<small>源码 + 实时预览</small>
									</span>
								</button>
								<button className="new-menu__item" onClick={() => void createMap('drawio')}>
									<PenLine size={15} strokeWidth={1.9} />
									<span>
										<b>draw.io 图表</b>
										<small>嵌入官方编辑器</small>
									</span>
								</button>
							</div>
						) : null}
					</div>

					<button
						className="btn-ghost btn-icon-text"
						onClick={() => fileRef.current?.click()}
						disabled={importing}
						title="导入：MindFlow JSON / ProcessOn JSON / .md / .drawio"
					>
						<Upload size={15} strokeWidth={1.9} />
						{importing ? '导入中…' : '导入'}
					</button>
					<input
						ref={fileRef}
						type="file"
						accept=".json,.md,.markdown,.txt,.drawio,.xml,application/json,text/markdown,application/xml"
						hidden
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void importFile(file);
						}}
					/>
					{maps.length ? (
						<div className="dash__filters">
							<div className="dash__search-wrap">
								<Search size={15} strokeWidth={1.9} className="dash__search-icon" />
								<input
									className="dash__search"
									placeholder="搜索标题…"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
								/>
							</div>
							<div className="dash__sort-wrap">
								<ArrowDownWideNarrow size={15} strokeWidth={1.9} className="dash__sort-icon" />
								<select
									className="dash__sort"
									value={sort}
									onChange={(e) => setSort(e.target.value as typeof sort)}
									title="排序方式"
								>
									<option value="updated">最近编辑</option>
									<option value="created">创建时间</option>
									<option value="title">按标题</option>
								</select>
							</div>
						</div>
					) : null}
				</div>

				{loading ? (
					<div className="dash__empty">
						<div className="spinner" />
					</div>
				) : maps.length === 0 ? (
					<div className="dash__empty">
						<div className="dash__empty-icon">
							<FolderOpen size={44} strokeWidth={1.3} />
						</div>
						<p>还没有导图，点击「新建」开始第一个。</p>
						<button className="btn-primary btn-icon-text" onClick={() => void createMap('mind')}>
							<Plus size={16} strokeWidth={2.2} />
							新建导图
						</button>
					</div>
				) : visible.length === 0 ? (
					<div className="dash__empty">
						<p>没有匹配「{query}」的导图。</p>
					</div>
				) : (
					<div className="grid">
						{visible.map((m) => (
							<article key={m.id} className="card">
								<button className="card__preview" onClick={() => navigate(`/map/${m.id}`)} title="打开编辑">
									<Thumbnail data={m.data} />
								</button>

								<div className="card__tools">
									<button
										className={`tool${m.shareToken ? ' is-on' : ''}`}
										title={m.shareToken ? '已分享 · 点击管理' : '分享'}
										onClick={(e) => {
											e.stopPropagation();
											if (m.shareToken) setShareFor(m);
											else void openShare(m);
										}}
									>
										{m.shareToken ? (
											<Link2 size={15} strokeWidth={1.9} />
										) : (
											<Lock size={15} strokeWidth={1.9} />
										)}
									</button>
									<button
										className="tool"
										title="下载 JSON"
										onClick={(e) => {
											e.stopPropagation();
											void download(m);
										}}
									>
										<Download size={15} strokeWidth={1.9} />
									</button>
									<button
										className="tool"
										title="重命名"
										onClick={(e) => {
											e.stopPropagation();
											setRenaming({ id: m.id, title: m.title });
										}}
									>
										<Pencil size={15} strokeWidth={1.9} />
									</button>
									<button
										className="tool tool-danger"
										title="删除"
										onClick={(e) => {
											e.stopPropagation();
											setConfirmDelete(m);
										}}
									>
										<Trash2 size={15} strokeWidth={1.9} />
									</button>
								</div>

								<footer className="card__meta">
									<div className="card__title-row">
										<Network size={14} strokeWidth={1.9} className="card__icon" />
										<span className="card__title" title={m.title}>
											{m.title}
										</span>
									</div>
									<span className="card__time">{fmtDate(m.updatedAt)}</span>
								</footer>
							</article>
						))}
					</div>
				)}
			</main>

			{confirmDelete ? (
				<div className="modal-mask" onClick={() => setConfirmDelete(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>删除「{confirmDelete.title}」？</h3>
						<p className="modal__hint">此操作不可撤销。</p>
						<div className="modal__actions">
							<button className="btn-ghost" onClick={() => setConfirmDelete(null)}>
								取消
							</button>
							<button className="btn-danger" onClick={() => void doDelete(confirmDelete)}>
								删除
							</button>
						</div>
					</div>
				</div>
			) : null}

			{shareFor?.shareToken ? (
				<div className="modal-mask" onClick={() => setShareFor(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>分享「{shareFor.title}」</h3>
						<p className="modal__hint">任何拿到链接的人都可以只读查看。</p>
						<div className="share-row">
							<input
								readOnly
								value={`${window.location.origin}/s/${shareFor.shareToken}`}
								onFocus={(e) => e.target.select()}
							/>
							<button
								className="btn-primary"
								onClick={() => {
									void navigator.clipboard.writeText(`${window.location.origin}/s/${shareFor.shareToken}`);
									toast('已复制', 'success');
								}}
							>
								复制
							</button>
						</div>
						<div className="modal__actions">
							<button
								className="btn-ghost btn-icon-text"
								onClick={() => void resetShare(shareFor)}
								title="生成新链接，旧链接立即失效"
							>
								<RefreshCw size={15} strokeWidth={1.9} />
								换一个链接
							</button>
							<button className="btn-ghost danger" onClick={() => void closeShare(shareFor)}>
								关闭分享
							</button>
							<button className="btn-ghost" onClick={() => setShareFor(null)}>
								完成
							</button>
						</div>
					</div>
				</div>
			) : null}

			{renaming ? (
				<div className="modal-mask" onClick={() => setRenaming(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>重命名</h3>
						<input
							autoFocus
							className="modal__input"
							value={renaming.title}
							onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
							onKeyDown={(e) => {
								if (e.key === 'Enter') void rename();
								if (e.key === 'Escape') setRenaming(null);
							}}
						/>
						<div className="modal__actions">
							<button className="btn-ghost" onClick={() => setRenaming(null)}>
								取消
							</button>
							<button className="btn-primary" onClick={() => void rename()}>
								保存
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
