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
 * The product rule is deliberately narrow: only a QQ mailbox whose number is
 * 5-10 digits (123456789@qq.com) may register. The server enforces it too —
 * the check here only saves a round trip.
 *
 * The form asks for the QQ number only; `@qq.com` is a fixed visual suffix, so
 * the full address is assembled in `qqEmail` before it hits the API.
 */
const QQ_NUM_RE = /^\d{5,10}$/;

export default function Register({ onSuccess }: RegisterProps) {
	const [qqNum, setQqNum] = useState('');
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

	const qqEmail = qqNum ? `${qqNum}@qq.com` : '';
	const emailOk = QQ_NUM_RE.test(qqNum);
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
			setError('QQ 号需为 5-10 位数字');
			return;
		}
		if (captchaRequired && !captchaToken) {
			setError('请先完成人机验证');
			return;
		}
		setSending(true);
		setError(null);
		try {
			await api.requestCode(qqEmail, captchaToken);
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
	}, [qqEmail, emailOk, sending, captchaRequired, captchaToken]);

	const submit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (busy) return;
			if (!emailOk) {
				setError('QQ 号需为 5-10 位数字');
				return;
			}
			setBusy(true);
			setError(null);
			try {
				const { user } = await api.register({
					email: qqEmail,
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
		[qqEmail, emailOk, code, password, name, busy, onSuccess],
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
					<div className="qqinput">
						<input
							type="text"
							inputMode="numeric"
							autoComplete="username"
							value={qqNum}
							onChange={(e) => setQqNum(e.target.value.replace(/\D/g, '').slice(0, 10))}
							placeholder="123456789"
							required
						/>
						<span className="qqinput__suffix">@qq.com</span>
					</div>
					{qqNum && !emailOk ? (
						<small className="field__warn">QQ 号需为 5-10 位数字</small>
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
