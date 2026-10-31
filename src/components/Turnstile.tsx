import { useCallback, useEffect, useRef, useState } from 'react';
import { loadTurnstile } from '../lib/turnstile';

interface TurnstileProps {
	sitekey: string;
	/** Forwarded to siteverify; the worker only sees `action: 'request-code'`. */
	action?: string;
	/** Latest solved token, or `null` while the challenge is pending/expired. */
	onToken: (token: string | null) => void;
	/** Bump this counter to reset the widget — tokens are single-use. */
	resetKey: number;
	/** Match the card's color scheme. */
	theme?: 'light' | 'dark' | 'auto';
}

/** How many silent re-arms we attempt before handing control back to the user. */
const MAX_AUTO_RETRIES = 2;

/**
 * Cloudflare Turnstile challenge widget.
 *
 * Renders into a placeholder div; the parent owns the token and bumps
 * `resetKey` after every request-code call so a fresh single-use token can
 * be earned for the next attempt.
 *
 * Failure handling matters as much as the happy path: an expired token keeps
 * the green tick on screen (re-arm immediately), but a challenge ERROR drops
 * the iframe entirely — re-mounting blindly can loop, so after a couple of
 * automatic retries the widget shows a manual retry button instead. A stuck
 * or hidden widget must never leave the user with a dead "完成上方人机验证"
 * hint and no way forward.
 */
export function Turnstile({ sitekey, action, onToken, resetKey, theme = 'auto' }: TurnstileProps) {
	const holder = useRef<HTMLDivElement>(null);
	const widgetId = useRef<string | null>(null);
	const errors = useRef(0);
	const [failed, setFailed] = useState(false);
	// keep the newest callback without re-rendering the (iframe-owned) widget
	const tokenRef = useRef(onToken);
	tokenRef.current = onToken;

	const mount = useCallback(() => {
		if (widgetId.current || !holder.current) return;
		void loadTurnstile()
			.then((ts) => {
				// StrictMode runs effects twice; the widgetId guard keeps a single widget
				if (widgetId.current || !holder.current) return;
				widgetId.current = ts.render(holder.current, {
					sitekey,
					action,
					theme,
					callback: (token) => {
						errors.current = 0;
						setFailed(false);
						tokenRef.current(token);
					},
					'expired-callback': () => {
						// the widget still shows the old green tick; reset re-runs
						// it and a fresh token arrives through `callback`
						tokenRef.current(null);
						void loadTurnstile().then((t) => {
							if (widgetId.current) t.reset(widgetId.current);
						});
					},
					'error-callback': () => {
						tokenRef.current(null);
						// Cloudflare may have torn the iframe down already;
						// clean up defensively so re-mount cannot double-render
						const stale = widgetId.current;
						widgetId.current = null;
						if (stale) void loadTurnstile().then((t) => { try { t.remove(stale); } catch { /* gone */ } });
						if (errors.current++ < MAX_AUTO_RETRIES) mount();
						else setFailed(true);
					},
				});
			})
			.catch(() => {
				widgetId.current = null;
				setFailed(true);
			});
	}, [sitekey, action, theme]);

	useEffect(() => {
		mount();
	}, [mount]);

	const retry = useCallback(() => {
		errors.current = 0;
		setFailed(false);
		mount();
	}, [mount]);

	useEffect(() => {
		const id = widgetId.current;
		if (!id || resetKey === 0) return;
		void loadTurnstile().then((ts) => ts.reset(id));
	}, [resetKey]);

	return (
		<div className="turnstile">
			<div ref={holder} aria-label="人机验证" />
			{failed ? (
				<button type="button" className="btn-ghost turnstile__retry" onClick={retry}>
					人机验证加载失败，点击重试
				</button>
			) : null}
		</div>
	);
}
