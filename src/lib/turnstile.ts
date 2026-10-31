/**
 * Minimal loader + typings for Cloudflare Turnstile's explicit-render API.
 *
 * The script is fetched once from Cloudflare; `window.turnstile` exists as
 * soon as it finishes loading (`?render=explicit` means nothing renders
 * automatically — widgets are created with `turnstile.render()`).
 */

export interface TurnstileWidgetOptions {
	sitekey: string;
	/** Called with the single-use token once the visitor passes the check. */
	callback?: (token: string) => void;
	/** Token expired (~60 s without being used) — the widget must be reset. */
	'expired-callback'?: () => void;
	'error-callback'?: () => void;
	/** Tag forwarded to siteverify; lets the server tell widgets apart. */
	action?: string;
	size?: 'normal' | 'flexible' | 'compact';
	theme?: 'light' | 'dark' | 'auto';
	appearance?: 'always' | 'automatic' | 'backend';
}

export interface TurnstileGlobal {
	render: (element: HTMLElement, options: TurnstileWidgetOptions) => string;
	reset: (widgetId?: string) => void;
	remove: (widgetId: string) => void;
}

declare global {
	interface Window {
		turnstile?: TurnstileGlobal;
	}
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading: Promise<TurnstileGlobal> | null = null;

/** Resolve with the Turnstile API; rejects (and allows a retry) on load failure. */
export function loadTurnstile(): Promise<TurnstileGlobal> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	if (!loading) {
		loading = new Promise<TurnstileGlobal>((resolve, reject) => {
			const script = document.createElement('script');
			script.src = SCRIPT_SRC;
			script.async = true;
			script.onload = () => {
				if (window.turnstile) resolve(window.turnstile);
				else reject(new Error('Turnstile script loaded but window.turnstile is missing'));
			};
			script.onerror = () => {
				loading = null;
				script.remove();
				reject(new Error('Failed to load the Turnstile script'));
			};
			document.head.appendChild(script);
		});
	}
	return loading;
}
