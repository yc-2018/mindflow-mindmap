import { useCallback, useState } from 'react';
import { Logo } from '../components/Logo';
import { api, ApiError, type User } from '../lib/api';
import { toast } from '../lib/toast';

interface LoginProps {
	onSuccess: (user: User) => void;
}

export default function Login({ onSuccess }: LoginProps) {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (busy) return;
			setBusy(true);
			setError(null);
			try {
				const { user } = await api.login(email.trim(), password);
				onSuccess(user);
				toast(`欢迎回来，${user.name}`, 'success');
			} catch (err) {
				setError(err instanceof ApiError ? err.message : '登录失败');
			} finally {
				setBusy(false);
			}
		},
		[email, password, busy, onSuccess],
	);

	return (
		<div className="auth">
			<div className="auth__bg" />
			<form className="auth__card" onSubmit={submit}>
				<div className="auth__logo">
					<Logo size={44} />
				</div>
				<h1>MindFlow</h1>
				<p className="auth__sub">登录以管理你的思维导图</p>

				<label className="field">
					<span>邮箱</span>
					<input
						type="email"
						autoComplete="username"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="you@example.com"
						required
					/>
				</label>

				<label className="field">
					<span>密码</span>
					<input
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="••••••••"
						required
					/>
				</label>

				{error ? <div className="auth__error">{error}</div> : null}

				<button className="btn-primary auth__submit" type="submit" disabled={busy}>
					{busy ? '登录中…' : '登录'}
				</button>

				<p className="auth__hint">账号由管理员创建，如需开通请联系管理员。</p>
			</form>
		</div>
	);
}
