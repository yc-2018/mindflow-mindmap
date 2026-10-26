import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	ArrowDownWideNarrow,
	Download,
	FolderOpen,
	Link2,
	Lock,
	LogOut,
	Map as MapIcon,
	Network,
	Pencil,
	Plus,
	Search,
	Share2,
	Trash2,
	Users,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';

import Thumbnail from '../components/Thumbnail';
import { Logo } from '../components/Logo';
import { api, ApiError, type MapSummary, type User } from '../lib/api';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';
import { parseDoc, serializeDoc, type MapDoc, type MindNode } from '../lib/types';
import { layoutTree } from '../lib/layout';
import { uid } from '../lib/uid';

interface DashboardProps {
	user: User;
	onLogout: () => void;
}

function starterDoc(): string {
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

	const createMap = useCallback(async () => {
		if (creating) return;
		setCreating(true);
		try {
			const { map } = await api.createMap('未命名导图', starterDoc());
			navigate(`/map/${map.id}`);
		} catch {
			toast('创建失败', 'error');
		} finally {
			setCreating(false);
		}
	}, [creating]);

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

	const download = useCallback(async (m: MapSummary) => {
		const doc = parseDoc(m.data);
		const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${m.title || 'mindflow'}.json`;
		a.click();
		URL.revokeObjectURL(url);
		toast('已导出 JSON', 'success');
	}, []);

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
					<button className="btn-primary btn-new" onClick={createMap} disabled={creating}>
						<Plus size={17} strokeWidth={2.2} />
						新建
					</button>
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
						<button className="btn-primary btn-icon-text" onClick={createMap}>
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
