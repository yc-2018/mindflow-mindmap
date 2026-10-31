import { useEffect, useRef } from 'react';
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

/**
 * Cloudflare Turnstile challenge widget.
 *
 * Renders once into a placeholder div. The parent owns the token: it hands
 * `onToken` a fresh single-use token and bumps `resetKey` after every
 * request-code call so the visitor earns a new one for the next attempt.
 * If the script cannot be loaded the box stays empty — the server still
 * refuses the request, so a hidden widget can never be bypassed client-side.
 */
export function Turnstile({ sitekey, action, onToken, resetKey, theme = 'auto' }: TurnstileProps) {
	const holder = useRef<HTMLDivElement>(null);
	const widgetId = useRef<string | null>(null);
	// keep the newest callback without re-rendering the (iframe-owned) widget
	const tokenRef = useRef(onToken);
	tokenRef.current = onToken;

	useEffect(() => {
		let cancelled = false;
		void loadTurnstile()
			.then((ts) => {
				// StrictMode runs effects twice; the widgetId guard keeps a single widget
				if (cancelled || widgetId.current || !holder.current) return;
				widgetId.current = ts.render(holder.current, {
					sitekey,
					action,
					theme,
					callback: (token) => tokenRef.current(token),
					'expired-callback': () => tokenRef.current(null),
					'error-callback': () => tokenRef.current(null),
				});
			})
			.catch(() => {
				if (!cancelled) tokenRef.current(null);
			});
		return () => {
			cancelled = true;
		};
	}, [sitekey, action, theme]);

	useEffect(() => {
		const id = widgetId.current;
		if (!id || resetKey === 0) return;
		void loadTurnstile().then((ts) => ts.reset(id));
	}, [resetKey]);

	return <div className="turnstile" ref={holder} aria-label="人机验证" />;
}
