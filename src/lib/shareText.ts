import { api } from './api';

/**
 * The text that lands on the clipboard when someone copies a share link.
 *
 * A bare URL is unfriendly to paste into WeChat/DingTalk — the recipient sees
 * no context, and half of chat tools won't unfurl custom domains. So every
 * copy entry point shares ONE template:
 *
 *   小陈 分享给你的
 *   「智能调度车辆匹配流程图」
 *   https://mindflow.245556.xyz/s/xxxx
 *
 * The sharer's display name comes from /api/auth/me and is cached for the
 * whole session (every copy would otherwise re-fetch it).
 */

export function shareUrl(token: string): string {
	return `${window.location.origin}/s/${token}`;
}

let namePromise: Promise<string | null> | null = null;

function sharerName(): Promise<string | null> {
	if (!namePromise) {
		namePromise = api
			.me()
			.then((r) => r.user?.name?.trim() || null)
			.catch(() => null);
	}
	return namePromise;
}

/** Build the multi-line share blurb for a title + token. */
export async function buildShareText(title: string, token: string): Promise<string> {
	const url = shareUrl(token);
	const name = await sharerName();
	const head = name ? `${name} 分享给你的` : '分享给你的';
	return `${head}\n「${(title || '未命名').trim()}」\n${url}`;
}
