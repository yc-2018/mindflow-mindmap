/// <reference types="@cloudflare/workers-types" />

export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	// Secrets (set with `wrangler secret put`)
	ADMIN_EMAIL: string;
	ADMIN_PASSWORD: string;
	SESSION_SECRET: string;
	/** Resend API key used to deliver registration codes. */
	RESEND_API_KEY?: string;
	/** Verified sender, e.g. `MindFlow <noreply@mail.245556.xyz>`. */
	MAIL_FROM?: string;
	/**
	 * Cloudflare Turnstile (人机验证).
	 *
	 * The captcha is enforced ONLY when both values are present, so local dev
	 * keeps working without keys. Set the secret with
	 *   wrangler secret put TURNSTILE_SECRET_KEY
	 * and keep the public site key in wrangler.jsonc `vars`.
	 */
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	// Optional
	PIXHOST_API?: string;
}

const SESSION_COOKIE = 'mf_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

// ---------- crypto helpers ----------

function b64url(bytes: ArrayBuffer | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = '';
	for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
	const out = new Uint8Array(b.length);
	for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
	return out;
}

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify',
	]);
}

/** Sign a compact JWT-like token: base64url(payload).base64url(hmac) */
async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
	const body = b64url(enc.encode(JSON.stringify(payload)));
	const key = await hmacKey(secret);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
	return `${body}.${b64url(sig)}`;
}

async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
	const parts = token.split('.');
	if (parts.length !== 2) return null;
	const [body, sig] = parts;
	try {
		const key = await hmacKey(secret);
		const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(body));
		if (!ok) return null;
		const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
		if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
		return payload;
	} catch {
		return null;
	}
}

/** PBKDF2 password hashing (SHA-256, 100k iterations). */
async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
	const saltBytes = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: saltBytes as unknown as BufferSource, iterations: 100_000, hash: 'SHA-256' },
		keyMaterial,
		256,
	);
	return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(saltBytes) };
}

async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
	const out = await hashPassword(password, salt);
	// constant-time-ish compare
	if (out.hash.length !== hash.length) return false;
	let diff = 0;
	for (let i = 0; i < out.hash.length; i++) diff |= out.hash.charCodeAt(i) ^ hash.charCodeAt(i);
	return diff === 0;
}

function bytesToHex(b: Uint8Array): string {
	return Array.from(b)
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function randomId(bytes = 16): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------- HTTP helpers ----------

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function fail(message: string, status = 400): Response {
	return json({ error: message }, status);
}

function parseCookies(header: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const idx = part.indexOf('=');
		if (idx === -1) continue;
		out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
	}
	return out;
}

function sessionCookie(token: string, secure: boolean, maxAge = SESSION_TTL): string {
	const sec = secure ? '; Secure' : '';
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly${sec}; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(secure: boolean): string {
	const sec = secure ? '; Secure' : '';
	return `${SESSION_COOKIE}=; Path=/; HttpOnly${sec}; SameSite=Lax; Max-Age=0`;
}

/** Cookies need `Secure` in production (https) but not over plain http in local dev. */
function isSecureRequest(request: Request): boolean {
	return new URL(request.url).protocol === 'https:';
}

interface SessionUser {
	id: string;
	email: string;
	name: string;
	role: 'admin' | 'user';
}

async function currentUser(request: Request, env: Env): Promise<SessionUser | null> {
	const cookies = parseCookies(request.headers.get('Cookie'));
	const token = cookies[SESSION_COOKIE];
	if (!token) return null;
	const payload = await verifyToken(token, env.SESSION_SECRET || 'dev-insecure-secret');
	if (!payload || typeof payload.sub !== 'string') return null;
	const row = await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?')
		.bind(payload.sub)
		.first<SessionUser>();
	return row ?? null;
}

async function issueSession(user: SessionUser, env: Env): Promise<string> {
	return signToken(
		{
			sub: user.id,
			email: user.email,
			role: user.role,
			exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
		},
		env.SESSION_SECRET || 'dev-insecure-secret',
	);
}

// ---------- route handlers ----------

async function ensureAdmin(env: Env): Promise<void> {
	const adminEmail = (env.ADMIN_EMAIL || 'admin@mindflow.local').toLowerCase();
	const adminPassword = env.ADMIN_PASSWORD || 'admin123456';
	const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(adminEmail).first();
	if (existing) return;
	const { hash, salt } = await hashPassword(adminPassword);
	await env.DB.prepare(
		'INSERT INTO users (id, email, name, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(randomId(), adminEmail, '管理员', hash, salt, 'admin', Date.now())
		.run();
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { email?: string; password?: string } | null;
	if (!body?.email || !body?.password) return fail('请输入邮箱和密码');

	const email = body.email.trim().toLowerCase();
	const row = await env.DB.prepare(
		'SELECT id, email, name, role, password_hash, salt FROM users WHERE email = ?',
	)
		.bind(email)
		.first<SessionUser & { password_hash: string; salt: string }>();

	if (!row) return fail('邮箱或密码不正确', 401);
	const ok = await verifyPassword(body.password, row.password_hash, row.salt);
	if (!ok) return fail('邮箱或密码不正确', 401);

	const user: SessionUser = { id: row.id, email: row.email, name: row.name, role: row.role };
	const token = await issueSession(user, env);
	return json({ user }, 200, { 'Set-Cookie': sessionCookie(token, isSecureRequest(request)) });
}

async function handleLogout(request: Request): Promise<Response> {
	return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(isSecureRequest(request)) });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
	const user = await currentUser(request, env);
	if (!user) return fail('未登录', 401);
	return json({ user });
}

// ---------- self-service registration ----------

/**
 * The ONLY addresses allowed to self-register.
 *
 * The product rule is "a QQ mailbox whose local part is all digits", e.g.
 * 123456789@qq.com. Anything else (foxmail.com, letters, dots) is rejected.
 */
const QQ_DIGITS_RE = /^\d{5,12}@qq\.com$/;

const CODE_TTL_MS = 10 * 60 * 1000; // a code stays valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // one request per minute per address
const MAX_ATTEMPTS = 5;

/** Turnstile is mandatory as soon as both keys are configured. */
function turnstileConfigured(env: Env): boolean {
	return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/**
 * Exchange the browser token for a verdict at Cloudflare's siteverify API.
 *
 * Returns `null` when the request may proceed, or a Chinese error message when
 * it must be refused. Two properties worth knowing:
 *  - tokens are single-use: siteverify consumes the token, so every resend of
 *    a code needs a freshly solved widget;
 *  - this fails CLOSED when Cloudflare is unreachable — a broken captcha
 *    check must not silently degrade into "no captcha", because the whole
 *    point is protecting the Resend quota from email-bombing scripts.
 */
async function verifyTurnstile(env: Env, token: unknown, request: Request): Promise<string | null> {
	if (!turnstileConfigured(env)) return null; // captcha off → nothing to check
	if (typeof token !== 'string' || !token) return '请先完成人机验证';

	try {
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				secret: env.TURNSTILE_SECRET_KEY,
				response: token,
				remoteip: request.headers.get('CF-Connecting-IP') || undefined,
			}),
		});
		const data = (await res.json().catch(() => null)) as {
			success?: boolean;
			'error-codes'?: string[];
		} | null;
		if (!data?.success) {
			console.error('turnstile rejected:', data?.['error-codes']?.join(',') ?? `http ${res.status}`);
			return '人机验证未通过，请重新完成验证后再点“获取验证码”';
		}
		return null;
	} catch (e) {
		console.error('turnstile unreachable:', e instanceof Error ? e.message : e);
		return '人机验证服务暂时不可用，请稍后再试';
	}
}

function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

/** A 6-digit numeric code. */
function sixDigits(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) out += String(b % 10);
	return out;
}

/**
 * Send the verification code through Resend.
 *
 * Returns `{ ok: false, message }` when the API rejects the request, so the
 * caller can tell the user instead of silently dropping the code.
 */
async function sendVerifyEmail(
	env: Env,
	to: string,
	code: string,
): Promise<{ ok: boolean; message?: string }> {
	const apiKey = env.RESEND_API_KEY;
	const from = env.MAIL_FROM || 'MindFlow <noreply@mail.245556.xyz>';

	if (!apiKey) {
		return { ok: false, message: '邮件服务未配置' };
	}

	const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1e2432">
  <h2 style="margin:0 0 8px;font-size:20px;font-weight:600">MindFlow 注册验证码</h2>
  <p style="margin:0 0 24px;color:#5b6478;font-size:14px;line-height:1.6">
    你正在注册 MindFlow 思维导图，请输入下面的验证码完成注册。
  </p>
  <div style="background:#f4f6fb;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px">
    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#4f46e5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</span>
  </div>
  <p style="margin:0 0 8px;color:#5b6478;font-size:13px;line-height:1.6">
    验证码 <strong>10 分钟</strong>内有效，请勿告诉他人。
  </p>
  <p style="margin:0;color:#8b94a7;font-size:12px;line-height:1.6">
    如果不是你本人操作，忽略这封邮件即可，不会产生任何账号。
  </p>
</div>`.trim();

	const text =
		`MindFlow 注册验证码\n\n` +
		`${code}\n\n` +
		`验证码 10 分钟内有效，请勿告诉他人。\n` +
		`如果不是你本人操作，忽略这封邮件即可。\n`;

	try {
		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				from,
				to: [to],
				subject: 'MindFlow 注册验证码',
				html,
				text,
			}),
		});

		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			// keep the upstream reason short: it is shown to the user
			let message = '验证码发送失败，请稍后再试';
			try {
				const parsed = JSON.parse(detail) as { message?: string };
				if (parsed?.message) message = parsed.message;
			} catch {
				/* keep the generic message */
			}
			console.error('resend rejected:', res.status, detail.slice(0, 200));
			return { ok: false, message };
		}

		return { ok: true };
	} catch (e) {
		console.error('resend request failed:', e instanceof Error ? e.message : e);
		return { ok: false, message: '邮件服务暂时不可用，请稍后再试' };
	}
}

async function handleRequestCode(request: Request, env: Env): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { email?: string; turnstileToken?: string } | null;
	if (!body?.email) return fail('请输入邮箱');

	const email = normalizeEmail(body.email);
	if (!QQ_DIGITS_RE.test(email)) {
		return fail('只支持纯数字的 QQ 邮箱（如 123456789@qq.com）');
	}

	// Human check first: a bot never gets close to the email-sending path.
	// The token is consumed here, even if the request is refused below.
	const captchaError = await verifyTurnstile(env, body.turnstileToken, request);
	if (captchaError) return fail(captchaError, 400);

	// already registered?
	const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
	if (exists) return fail('该邮箱已注册，请直接登录');

	const now = Date.now();

	// rate limit: at most one request per minute per address
	const recent = await env.DB.prepare(
		'SELECT created_at FROM verify_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1',
	)
		.bind(email)
		.first<{ created_at: number }>();
	if (recent && now - recent.created_at < RESEND_COOLDOWN_MS) {
		const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - recent.created_at)) / 1000);
		return fail(`请 ${wait} 秒后再试`, 429);
	}

	const code = sixDigits();
	await env.DB.prepare(
		'INSERT INTO verify_codes (id, email, code, attempts, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)',
	)
		.bind(randomId(), email, code, now, now + CODE_TTL_MS)
		.run();

	/**
	 * Deliver the code through Resend's HTTP API.
	 *
	 * Workers cannot speak SMTP (port 25 is blocked and the TCP socket API has
	 * no TLS layer), but a plain `fetch()` to an email API works fine — which is
	 * why the sending channel is Resend rather than the QQ mailbox.
	 */
	const sent = await sendVerifyEmail(env, email, code);
	if (!sent.ok) {
		// the code row is useless without a delivery; mark it used so it cannot
		// be replayed, and tell the user to retry
		await env.DB.prepare('UPDATE verify_codes SET used_at = ? WHERE email = ? AND used_at IS NULL')
			.bind(Date.now(), email)
			.run();
		return fail(sent.message || '验证码发送失败，请稍后再试', 502);
	}

	await env.DB.prepare(
		'UPDATE verify_codes SET sent_at = ? WHERE email = ? AND sent_at IS NULL',
	)
		.bind(Date.now(), email)
		.run();

	return json({ ok: true, sent: true });
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
	const body = (await request.json().catch(() => null)) as
		| { email?: string; code?: string; password?: string; name?: string }
		| null;
	if (!body?.email || !body?.code || !body?.password) {
		return fail('请填写邮箱、验证码和密码');
	}

	const email = normalizeEmail(body.email);
	if (!QQ_DIGITS_RE.test(email)) {
		return fail('只支持纯数字的 QQ 邮箱（如 123456789@qq.com）');
	}
	if (body.password.length < 6) return fail('密码至少 6 位');

	const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
	if (exists) return fail('该邮箱已注册，请直接登录');

	const row = await env.DB.prepare(
		'SELECT id, code, attempts, expires_at, used_at FROM verify_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1',
	)
		.bind(email)
		.first<{ id: string; code: string; attempts: number; expires_at: number; used_at: number | null }>();

	if (!row) return fail('请先获取验证码');
	if (row.used_at) return fail('验证码已使用，请重新获取');
	if (Date.now() > row.expires_at) return fail('验证码已过期，请重新获取');
	if (row.attempts >= MAX_ATTEMPTS) return fail('尝试次数过多，请重新获取验证码', 429);

	if (row.code !== body.code.trim()) {
		await env.DB.prepare('UPDATE verify_codes SET attempts = attempts + 1 WHERE id = ?')
			.bind(row.id)
			.run();
		return fail('验证码不正确');
	}

	// mark used first so a double submit cannot create two accounts
	await env.DB.prepare('UPDATE verify_codes SET used_at = ? WHERE id = ?').bind(Date.now(), row.id).run();

	const { hash, salt } = await hashPassword(body.password);
	const name = (body.name || '').trim() || email.split('@')[0];
	const id = randomId();
	await env.DB.prepare(
		'INSERT INTO users (id, email, name, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(id, email, name, hash, salt, 'user', Date.now())
		.run();

	const user: SessionUser = { id, email, name, role: 'user' };
	const token = await issueSession(user, env);
	return json({ user }, 201, { 'Set-Cookie': sessionCookie(token, isSecureRequest(request)) });
}


interface MapRow {
	id: string;
	owner_id: string;
	title: string;
	data: string;
	share_token: string | null;
	created_at: number;
	updated_at: number;
}

async function listMaps(request: Request, env: Env, user: SessionUser): Promise<Response> {
	const rows = await env.DB.prepare(
		'SELECT id, title, data, share_token, created_at, updated_at FROM maps WHERE owner_id = ? ORDER BY updated_at DESC',
	)
		.bind(user.id)
		.all<MapRow>();
	const items = (rows.results ?? []).map((r) => ({
		id: r.id,
		title: r.title,
		data: r.data,
		shareToken: r.share_token,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}));
	return json({ maps: items });
}

async function createMap(request: Request, env: Env, user: SessionUser): Promise<Response> {
	const body = (await request.json().catch(() => ({}))) as { title?: string; data?: string };
	const id = randomId();
	const now = Date.now();
	const title = (body.title || '未命名导图').slice(0, 120);
	const data = body.data || JSON.stringify({ nodes: [], edges: [] });
	await env.DB.prepare(
		'INSERT INTO maps (id, owner_id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
	)
		.bind(id, user.id, title, data, now, now)
		.run();
	return json({ map: { id, title, data, shareToken: null, createdAt: now, updatedAt: now } }, 201);
}

async function getMap(env: Env, user: SessionUser, id: string): Promise<Response> {
	const row = await env.DB.prepare(
		'SELECT id, owner_id, title, data, share_token, created_at, updated_at FROM maps WHERE id = ?',
	)
		.bind(id)
		.first<MapRow>();
	if (!row) return fail('导图不存在', 404);
	if (row.owner_id !== user.id && user.role !== 'admin') return fail('无权访问', 403);
	return json({
		map: {
			id: row.id,
			title: row.title,
			data: row.data,
			shareToken: row.share_token,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		},
	});
}

async function updateMap(request: Request, env: Env, user: SessionUser, id: string): Promise<Response> {
	const body = (await request.json().catch(() => ({}))) as { title?: string; data?: string };
	const row = await env.DB.prepare('SELECT owner_id FROM maps WHERE id = ?').bind(id).first<{ owner_id: string }>();
	if (!row) return fail('导图不存在', 404);
	if (row.owner_id !== user.id && user.role !== 'admin') return fail('无权访问', 403);

	const sets: string[] = [];
	const binds: unknown[] = [];
	if (typeof body.title === 'string') {
		sets.push('title = ?');
		binds.push(body.title.slice(0, 120));
	}
	if (typeof body.data === 'string') {
		sets.push('data = ?');
		binds.push(body.data);
	}
	if (!sets.length) return fail('没有要更新的内容');
	sets.push('updated_at = ?');
	binds.push(Date.now());
	binds.push(id);
	await env.DB.prepare(`UPDATE maps SET ${sets.join(', ')} WHERE id = ?`)
		.bind(...binds)
		.run();
	return json({ ok: true });
}

async function deleteMap(env: Env, user: SessionUser, id: string): Promise<Response> {
	const row = await env.DB.prepare('SELECT owner_id FROM maps WHERE id = ?').bind(id).first<{ owner_id: string }>();
	if (!row) return fail('导图不存在', 404);
	if (row.owner_id !== user.id && user.role !== 'admin') return fail('无权访问', 403);
	await env.DB.prepare('DELETE FROM maps WHERE id = ?').bind(id).run();
	return json({ ok: true });
}

/**
 * Turn sharing on/off, or rotate the token.
 *
 * `mode`:
 *  - 'on'    enable sharing (keeps the existing token if there is one)
 *  - 'off'   disable sharing (clears the token)
 *  - 'reset' rotate to a NEW token, invalidating every previously shared link
 *
 * Rotation exists because a share link is a bearer token: once it leaks there is
 * no way to take it back other than issuing a fresh one.
 */
async function shareMap(
	env: Env,
	user: SessionUser,
	id: string,
	mode: 'on' | 'off' | 'reset',
): Promise<Response> {
	const row = await env.DB.prepare('SELECT owner_id, share_token FROM maps WHERE id = ?')
		.bind(id)
		.first<{ owner_id: string; share_token: string | null }>();
	if (!row) return fail('导图不存在', 404);
	if (row.owner_id !== user.id && user.role !== 'admin') return fail('无权访问', 403);

	let token: string | null;
	if (mode === 'off') token = null;
	else if (mode === 'reset') token = randomId(12);
	else token = row.share_token || randomId(12);

	await env.DB.prepare('UPDATE maps SET share_token = ?, updated_at = ? WHERE id = ?')
		.bind(token, Date.now(), id)
		.run();
	return json({ shareToken: token });
}

async function getSharedMap(env: Env, token: string): Promise<Response> {
	const row = await env.DB.prepare(
		'SELECT id, title, data, created_at, updated_at FROM maps WHERE share_token = ?',
	)
		.bind(token)
		.first<MapRow>();
	if (!row) return fail('分享链接无效或已关闭', 404);
	return json({
		map: {
			id: row.id,
			title: row.title,
			data: row.data,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		},
	});
}

// ---------- admin: user management ----------

async function listUsers(env: Env): Promise<Response> {
	const rows = await env.DB.prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC').all();
	return json({ users: rows.results ?? [] });
}

async function createUser(request: Request, env: Env): Promise<Response> {
	const body = (await request.json().catch(() => null)) as
		| { email?: string; name?: string; password?: string; role?: string }
		| null;
	if (!body?.email || !body?.password) return fail('请填写邮箱和密码');
	const email = body.email.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('邮箱格式不正确');
	if (body.password.length < 6) return fail('密码至少 6 位');

	const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
	if (exists) return fail('该邮箱已被使用', 409);

	const { hash, salt } = await hashPassword(body.password);
	const id = randomId();
	const role = body.role === 'admin' ? 'admin' : 'user';
	const name = (body.name || email.split('@')[0]).slice(0, 60);
	await env.DB.prepare(
		'INSERT INTO users (id, email, name, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(id, email, name, hash, salt, role, Date.now())
		.run();
	return json({ user: { id, email, name, role } }, 201);
}

async function deleteUser(env: Env, actor: SessionUser, id: string): Promise<Response> {
	if (id === actor.id) return fail('不能删除自己');
	const row = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: string }>();
	if (!row) return fail('用户不存在', 404);
	await env.DB.prepare('DELETE FROM maps WHERE owner_id = ?').bind(id).run();
	await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
	return json({ ok: true });
}

async function resetPassword(request: Request, env: Env, id: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { password?: string } | null;
	if (!body?.password || body.password.length < 6) return fail('密码至少 6 位');
	const { hash, salt } = await hashPassword(body.password);
	await env.DB.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').bind(hash, salt, id).run();
	return json({ ok: true });
}

// ---------- image upload (pixhost proxy) ----------

/**
 * Derive the direct full-size image URL from a pixhost thumbnail URL.
 *
 * pixhost serves a file from several CDN hosts:
 *   thumbnail : https://t3.pixhost.cc/thumbs/<dir>/<file>
 *   original  : https://img3.pixhost.cc/images/<dir>/<file>
 * The show page (pixhost.cc/show/...) is an HTML page, not an image, so it
 * cannot be used as a lightbox src. Host numbers differ, so we rebuild it.
 */
function fullSizeUrl(thumbUrl: string, showUrl?: string): string | undefined {
	if (!thumbUrl) return undefined;
	try {
		const u = new URL(thumbUrl);
		// t3.pixhost.cc -> img3.pixhost.cc, /thumbs/ -> /images/
		const host = u.hostname.replace(/^t(\d*)\./, 'img$1.');
		const path = u.pathname.replace('/thumbs/', '/images/');
		return `https://${host}${path}`;
	} catch {
		return showUrl;
	}
}

async function handleUpload(request: Request): Promise<Response> {
	const form = await request.formData().catch(() => null);
	const file = form?.get('img');
	if (!(file instanceof File)) return fail('缺少图片文件');
	// pixhost rejects anything over 10 MB
	if (file.size > 10 * 1024 * 1024) {
		return fail(`图片 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过图床 10MB 限制`, 413);
	}

	const upstream = new FormData();
	upstream.append('img', file, file.name || 'image.webp');
	upstream.append('content_type', '0');
	upstream.append('max_th_size', '420');
	upstream.append('include_manage_url', '1');

	const res = await fetch('https://api.pixhost.cc/images', {
		method: 'POST',
		body: upstream,
		headers: { Accept: 'application/json' },
	});
	if (!res.ok) return fail(`图床返回 ${res.status}`, 502);
	const data = (await res.json()) as Record<string, unknown>;
	const thumbUrl = String(data.th_url ?? '');
	const showUrl = String(data.show_url ?? '');
	return json({
		showUrl,
		thumbUrl,
		fullUrl: fullSizeUrl(thumbUrl, showUrl),
		manageUrl: data.manage_url,
		width: data.thumb_width,
		height: data.thumb_height,
	});
}

// ---------- router ----------

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	// bootstrap admin on first API hit
	await ensureAdmin(env);

	// public
	if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
	if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request);
	if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);

	// captcha configuration for the register page (the site key is public;
	// the secret key never leaves the worker)
	if (path === '/api/auth/captcha' && method === 'GET') {
		const enabled = turnstileConfigured(env);
		return json({ enabled, siteKey: enabled ? env.TURNSTILE_SITE_KEY : null });
	}

	// self-service registration (public)
	if (path === '/api/auth/request-code' && method === 'POST') return handleRequestCode(request, env);
	if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env);

	// shared map (public)
	const sharedMatch = path.match(/^\/api\/share\/([A-Za-z0-9]+)$/);
	if (sharedMatch && method === 'GET') return getSharedMap(env, sharedMatch[1]);

	// everything below requires auth
	const user = await currentUser(request, env);
	if (!user) return fail('未登录', 401);

	if (path === '/api/maps' && method === 'GET') return listMaps(request, env, user);
	if (path === '/api/maps' && method === 'POST') return createMap(request, env, user);

	const mapMatch = path.match(/^\/api\/maps\/([A-Za-z0-9]+)$/);
	if (mapMatch) {
		const id = mapMatch[1];
		if (method === 'GET') return getMap(env, user, id);
		if (method === 'PATCH') return updateMap(request, env, user, id);
		if (method === 'DELETE') return deleteMap(env, user, id);
	}

	const shareMatch = path.match(/^\/api\/maps\/([A-Za-z0-9]+)\/share$/);
	if (shareMatch && method === 'POST') {
		const body = (await request.json().catch(() => ({}))) as { enabled?: boolean; reset?: boolean };
		// `reset: true` rotates the token; otherwise honour `enabled`
		const mode: 'on' | 'off' | 'reset' = body.reset ? 'reset' : body.enabled === false ? 'off' : 'on';
		return shareMap(env, user, shareMatch[1], mode);
	}

	if (path === '/api/upload' && method === 'POST') return handleUpload(request);

	// admin only
	if (path.startsWith('/api/admin/')) {
		if (user.role !== 'admin') return fail('需要管理员权限', 403);
		if (path === '/api/admin/users' && method === 'GET') return listUsers(env);
		if (path === '/api/admin/users' && method === 'POST') return createUser(request, env);
		const userMatch = path.match(/^\/api\/admin\/users\/([A-Za-z0-9]+)$/);
		if (userMatch && method === 'DELETE') return deleteUser(env, user, userMatch[1]);
		const pwMatch = path.match(/^\/api\/admin\/users\/([A-Za-z0-9]+)\/password$/);
		if (pwMatch && method === 'POST') return resetPassword(request, env, pwMatch[1]);
		return fail('未知的管理接口', 404);
	}

	return fail('接口不存在', 404);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/api/')) {
			try {
				return await route(request, env);
			} catch (err) {
				console.error('API error', err);
				return fail('服务器内部错误', 500);
			}
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
