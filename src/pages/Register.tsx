import { useCallback, useEffect, useState } from 'react';
import { Logo } from '../components/Logo';
import { Turnstile } from '../components/Turnstile';
import { api, ApiError, type CaptchaConfig, type User } from '../lib/api';
import { toast } from '../lib/toast';
import { navigate } from '../lib/router';

interface RegisterProps {
	onSuccess: (user: User) => void;
}

/**
 * Self-service registration.
 *
 * The product rule is deliberately narrow: only a QQ mailbox whose local part is
 * all digits (123456789@qq.com) may register. The server enforces it too — the
 * check here only saves a round trip.
 */
const QQ_DIGITS_RE = /^\d{5,12}@qq\.com$/;

export default function Register({ onSuccess }: RegisterProps) {
	const [email, setEmail] = useState('');
	const [code, setCode] = useState('');
	const [password, setPassword] = useState('');
	const [name, setName] = useState('');
	const [busy, setBusy] = useState(false);
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Turnstile: `null` while the server config is still unknown
	const [captcha, setCaptcha] = useState<CaptchaConfig | null>(null);
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [captchaReset, setCaptchaReset] = useState(0);

	const emailOk = QQ_DIGITS_RE.test(email.trim().toLowerCase());
	const captchaRequired = captcha?.enabled === true;
	const captchaPending = captchaRequired && !captchaToken;

	// ask the worker whether a human check is needed today
	useEffect(() => {
		let alive = true;
		api
			.captchaConfig()
			.then((cfg) => alive && setCaptcha(cfg))
			.catch(() => alive && setCaptcha({ enabled: false, siteKey: null }));
		return () => {
			alive = false;
		};
	}, []);

	const requestCode = useCallback(async () => {
		if (sending) return;
		if (!emailOk) {
			setError('只支持纯数字的 QQ 邮箱（如 123456789@qq.com）');
			return;
		}
		if (captchaRequired && !captchaToken) {
			setError('请先完成人机验证');
			return;
		}
		setSending(true);
		setError(null);
		try {
			await api.requestCode(email.trim(), captchaToken);
			setSent(true);
			toast('验证码已发送，请查收邮件', 'success');
		} catch (err) {
			setError(err instanceof ApiError ? err.message : '发送失败');
		} finally {
			setSending(false);
			// the server consumed the token even if it then refused the request
			// (wrong email, cooldown, …), so earn a fresh one for the next try
			if (captchaRequired) {
				setCaptchaToken(null);
				setCaptchaReset((n) => n + 1);
			}
		}
	}, [email, emailOk, sending, captchaRequired, captchaToken]);

	const submit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (busy) return;
			if (!emailOk) {
				setError('只支持纯数字的 QQ 邮箱（如 123456789@qq.com）');
				return;
			}
			setBusy(true);
			setError(null);
			try {
				const { user } = await api.register({
					email: email.trim(),
					code: code.trim(),
					password,
					name: name.trim() || undefined,
				});
				onSuccess(user);
				toast(`注册成功，欢迎 ${user.name}`, 'success');
			} catch (err) {
				setError(err instanceof ApiError ? err.message : '注册失败');
			} finally {
				setBusy(false);
			}
		},
		[email, emailOk, code, password, name, busy, onSuccess],
	);

	return (
		<div className="auth">
			<div className="auth__bg" />
			<form className="auth__card" onSubmit={submit}>
				<div className="auth__logo">
					<Logo size={44} />
				</div>
				<h1>MindFlow</h1>
				<p className="auth__sub">用 QQ 邮箱注册</p>

				<label className="field">
					<span>QQ 邮箱</span>
					<input
						type="email"
						autoComplete="username"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="123456789@qq.com"
						required
					/>
					{email && !emailOk ? (
						<small className="field__warn">只支持纯数字的 @qq.com 邮箱</small>
					) : null}
				</label>

				{/* Cloudflare Turnstile: only shown when the server requires it */}
				{captchaRequired && captcha?.siteKey ? (
					<Turnstile
						sitekey={captcha.siteKey}
						action="request-code"
						onToken={setCaptchaToken}
						resetKey={captchaReset}
					/>
				) : null}

				<label className="field">
					<span>验证码</span>
					<div className="field__row">
						<input
							type="text"
							inputMode="numeric"
							autoComplete="one-time-code"
							value={code}
							onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
							placeholder="6 位数字"
							required
						/>
						<button
							type="button"
							className="btn-ghost"
							onClick={() => void requestCode()}
							disabled={sending || !emailOk || captchaPending}
						>
							{sending ? '发送中…' : sent ? '重新发送' : '获取验证码'}
						</button>
					</div>
					{captchaPending ? <small className="field__hint">完成上方人机验证后可发送</small> : null}
				</label>

				<label className="field">
					<span>密码</span>
					<input
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="至少 6 位"
						minLength={6}
						required
					/>
				</label>

				<label className="field">
					<span>昵称（可选）</span>
					<input
						type="text"
						autoComplete="nickname"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="默认使用 QQ 号"
					/>
				</label>

				{error ? <div className="auth__error">{error}</div> : null}

				<button className="btn-primary auth__submit" type="submit" disabled={busy}>
					{busy ? '注册中…' : '注册'}
				</button>

				<p className="auth__hint">
					已有账号？
					<button type="button" className="auth__link" onClick={() => navigate('/login')}>
						去登录
					</button>
				</p>
			</form>
		</div>
	);
}
