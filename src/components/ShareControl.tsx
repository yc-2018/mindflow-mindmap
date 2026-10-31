import { useCallback, useState } from 'react';
import { Copy, Link2, RefreshCw, Share2 } from 'lucide-react';

import { api } from '../lib/api';
import { toast } from '../lib/toast';

interface Props {
	mapId: string;
	/** Current document title — only used for the modal heading. */
	title: string;
	/** Whether sharing is already on when the editor opens. */
	initialToken?: string | null;
	readOnly?: boolean;
}

/**
 * Share button + panel, shared by all three editors.
 *
 * Mirrors the dashboard's share flow so a link can be created, copied, rotated
 * or closed from inside the editor too — previously only the mind-map editor
 * had a share control, so Markdown and draw.io documents had no way to be
 * shared without going back to the list ("md 和 draw 在编辑页面没有分享按钮").
 */
export default function ShareControl({ mapId, title, initialToken = null, readOnly = false }: Props) {
	const [open, setOpen] = useState(false);
	const [token, setToken] = useState<string | null>(initialToken);
	const [busy, setBusy] = useState(false);

	const copy = useCallback(async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			toast('分享链接已复制', 'success');
		} catch {
			toast('复制失败，请手动选择链接', 'error');
		}
	}, []);

	const toggle = useCallback(
		async (enabled: boolean) => {
			if (busy) return;
			setBusy(true);
			try {
				const { shareToken } = await api.setShare(mapId, enabled);
				setToken(shareToken);
				if (enabled && shareToken) {
					await copy(`${window.location.origin}/s/${shareToken}`);
				} else {
					toast('已关闭分享', 'success');
				}
			} catch {
				toast('操作失败', 'error');
			} finally {
				setBusy(false);
			}
		},
		[busy, copy, mapId],
	);

	const reset = useCallback(async () => {
		if (busy) return;
		setBusy(true);
		try {
			const { shareToken } = await api.resetShare(mapId);
			setToken(shareToken);
			if (shareToken) {
				await copy(`${window.location.origin}/s/${shareToken}`);
				toast('已生成新链接，旧链接已失效', 'success');
			}
		} catch {
			toast('操作失败', 'error');
		} finally {
			setBusy(false);
		}
	}, [busy, copy, mapId]);

	if (readOnly) return null;

	return (
		<>
			<button
				className={`btn-ghost btn-icon-text${token ? ' is-on' : ''}`}
				onClick={() => setOpen(true)}
				title={token ? '已分享 · 点击管理' : '分享'}
			>
				{token ? <Link2 size={15} strokeWidth={1.9} /> : <Share2 size={15} strokeWidth={1.9} />}
				分享
			</button>

			{open ? (
				<div className="modal-mask" onClick={() => setOpen(false)}>
					<div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
						<h3>分享「{title || '未命名'}」</h3>

						{token ? (
							<>
								<p className="modal__hint">任何拿到链接的人都可以查看这个文件（只读，不能修改）。</p>
								<div className="share-row">
									<input
										readOnly
										value={`${window.location.origin}/s/${token}`}
										onFocus={(e) => e.currentTarget.select()}
									/>
									<button
										className="btn-primary btn-icon-text"
										onClick={() => void copy(`${window.location.origin}/s/${token}`)}
									>
										<Copy size={15} strokeWidth={1.9} />
										复制
									</button>
								</div>
								<div className="modal__actions">
									<button
										className="btn-ghost btn-icon-text"
										onClick={() => void reset()}
										disabled={busy}
										title="生成新链接，旧链接立即失效"
									>
										<RefreshCw size={15} strokeWidth={1.9} />
										{busy ? '处理中…' : '换一个链接'}
									</button>
									<button
										className="btn-ghost danger"
										onClick={() => void toggle(false)}
										disabled={busy}
									>
										关闭分享
									</button>
									<button className="btn-ghost" onClick={() => setOpen(false)}>
										完成
									</button>
								</div>
							</>
						) : (
							<>
								<p className="modal__hint">生成一条只读链接，发给别人就能查看这个文件。链接可以随时关闭。</p>
								<div className="modal__actions">
									<button className="btn-ghost" onClick={() => setOpen(false)}>
										取消
									</button>
									<button
										className="btn-primary btn-icon-text"
										onClick={() => void toggle(true)}
										disabled={busy}
									>
										<Share2 size={15} strokeWidth={1.9} />
										{busy ? '生成中…' : '生成分享链接'}
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			) : null}
		</>
	);
}
