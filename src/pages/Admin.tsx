import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, KeyRound, Trash2, UserPlus } from 'lucide-react';
import { api, ApiError, type AdminUser, type User } from '../lib/api';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';

interface Props {
	user: User;
}

export default function Admin({ user }: Props) {
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [loading, setLoading] = useState(true);
	const [showCreate, setShowCreate] = useState(false);
	const [form, setForm] = useState({ email: '', name: '', password: '', role: 'user' });
	const [busy, setBusy] = useState(false);
	const [pwFor, setPwFor] = useState<AdminUser | null>(null);
	const [newPw, setNewPw] = useState('');

	const load = useCallback(async () => {
		try {
			const { users: list } = await api.listUsers();
			setUsers(list);
		} catch {
			toast('加载用户失败', 'error');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const create = useCallback(async () => {
		if (!form.email || !form.password) {
			toast('请填写邮箱和密码', 'error');
			return;
		}
		setBusy(true);
		try {
			await api.createUser(form);
			setForm({ email: '', name: '', password: '', role: 'user' });
			setShowCreate(false);
			await load();
			toast('用户已创建', 'success');
		} catch (err) {
			toast(err instanceof ApiError ? err.message : '创建失败', 'error');
		} finally {
			setBusy(false);
		}
	}, [form, load]);

	const remove = useCallback(
		async (u: AdminUser) => {
			if (!confirm(`删除用户 ${u.email}？其所有导图也会被删除。`)) return;
			try {
				await api.deleteUser(u.id);
				setUsers((prev) => prev.filter((x) => x.id !== u.id));
				toast('已删除', 'success');
			} catch (err) {
				toast(err instanceof ApiError ? err.message : '删除失败', 'error');
			}
		},
		[],
	);

	const resetPw = useCallback(async () => {
		if (!pwFor || newPw.length < 6) {
			toast('密码至少 6 位', 'error');
			return;
		}
		try {
			await api.resetPassword(pwFor.id, newPw);
			setPwFor(null);
			setNewPw('');
			toast('密码已重置', 'success');
		} catch (err) {
			toast(err instanceof ApiError ? err.message : '重置失败', 'error');
		}
	}, [pwFor, newPw]);

	return (
		<div className="admin">
			<header className="admin__bar">
				<div className="dash__brand">
					<button className="icon-btn" onClick={() => navigate('/')} title="返回">
						<ChevronLeft size={18} strokeWidth={2} />
					</button>
					<span className="dash__name">用户管理</span>
				</div>
				<button className="btn-primary btn-icon-text" onClick={() => setShowCreate(true)}>
					<UserPlus size={16} strokeWidth={2} />
					新建用户
				</button>
			</header>

			<main className="admin__main">
				{loading ? (
					<div className="dash__empty">
						<div className="spinner" />
					</div>
				) : (
					<table className="table">
						<thead>
							<tr>
								<th>名称</th>
								<th>邮箱</th>
								<th>角色</th>
								<th>创建时间</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{users.map((u) => (
								<tr key={u.id}>
									<td>{u.name}</td>
									<td className="mono">{u.email}</td>
									<td>
										<span className={`badge ${u.role === 'admin' ? 'badge-admin' : ''}`}>
											{u.role === 'admin' ? '管理员' : '用户'}
										</span>
									</td>
									<td className="muted">{new Date(u.created_at).toLocaleDateString('zh-CN')}</td>
									<td className="right">
										<button className="btn-link btn-icon-text" onClick={() => setPwFor(u)}>
											<KeyRound size={13} strokeWidth={1.9} />
											重置密码
										</button>
										{u.id !== user.id ? (
											<button className="btn-link btn-icon-text danger" onClick={() => remove(u)}>
												<Trash2 size={13} strokeWidth={1.9} />
												删除
											</button>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</main>

			{showCreate ? (
				<div className="modal-mask" onClick={() => setShowCreate(false)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>新建用户</h3>
						<label className="field">
							<span>邮箱</span>
							<input
								autoFocus
								type="email"
								value={form.email}
								onChange={(e) => setForm({ ...form, email: e.target.value })}
								placeholder="user@example.com"
							/>
						</label>
						<label className="field">
							<span>名称（可选）</span>
							<input
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
								placeholder="显示名称"
							/>
						</label>
						<label className="field">
							<span>初始密码</span>
							<input
								type="text"
								value={form.password}
								onChange={(e) => setForm({ ...form, password: e.target.value })}
								placeholder="至少 6 位"
							/>
						</label>
						<label className="field">
							<span>角色</span>
							<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
								<option value="user">普通用户</option>
								<option value="admin">管理员</option>
							</select>
						</label>
						<div className="modal__actions">
							<button className="btn-ghost" onClick={() => setShowCreate(false)}>
								取消
							</button>
							<button className="btn-primary" onClick={create} disabled={busy}>
								{busy ? '创建中…' : '创建'}
							</button>
						</div>
					</div>
				</div>
			) : null}

			{pwFor ? (
				<div className="modal-mask" onClick={() => setPwFor(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>重置 {pwFor.email} 的密码</h3>
						<input
							autoFocus
							className="modal__input"
							type="text"
							value={newPw}
							onChange={(e) => setNewPw(e.target.value)}
							placeholder="新密码，至少 6 位"
							onKeyDown={(e) => e.key === 'Enter' && resetPw()}
						/>
						<div className="modal__actions">
							<button className="btn-ghost" onClick={() => setPwFor(null)}>
								取消
							</button>
							<button className="btn-primary" onClick={resetPw}>
								重置
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
