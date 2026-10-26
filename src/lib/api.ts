export interface User {
	id: string;
	email: string;
	name: string;
	role: 'admin' | 'user';
}

export interface MapSummary {
	id: string;
	title: string;
	data: string;
	shareToken: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface MapDetail {
	id: string;
	title: string;
	data: string;
	createdAt: number;
	updatedAt: number;
	shareToken?: string | null;
}

export interface AdminUser {
	id: string;
	email: string;
	name: string;
	role: 'admin' | 'user';
	created_at: number;
}

export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		credentials: 'same-origin',
		headers: init?.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
		...init,
	});
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = text;
	}
	if (!res.ok) {
		const msg =
			data && typeof data === 'object' && 'error' in data
				? String((data as { error: unknown }).error)
				: `请求失败 (${res.status})`;
		throw new ApiError(msg, res.status);
	}
	return data as T;
}

export const api = {
	login: (email: string, password: string) =>
		req<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
	logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
	me: () => req<{ user: User }>('/api/auth/me'),

	listMaps: () => req<{ maps: MapSummary[] }>('/api/maps'),
	createMap: (title: string, data: string) =>
		req<{ map: MapSummary }>('/api/maps', { method: 'POST', body: JSON.stringify({ title, data }) }),
	getMap: (id: string) => req<{ map: MapDetail }>(`/api/maps/${id}`),
	updateMap: (id: string, patch: { title?: string; data?: string }) =>
		req<{ ok: true }>(`/api/maps/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
	deleteMap: (id: string) => req<{ ok: true }>(`/api/maps/${id}`, { method: 'DELETE' }),
	setShare: (id: string, enabled: boolean) =>
		req<{ shareToken: string | null }>(`/api/maps/${id}/share`, {
			method: 'POST',
			body: JSON.stringify({ enabled }),
		}),
	getShared: (token: string) => req<{ map: MapDetail }>(`/api/share/${token}`),

	listUsers: () => req<{ users: AdminUser[] }>('/api/admin/users'),
	createUser: (payload: { email: string; name?: string; password: string; role?: string }) =>
		req<{ user: User }>('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
	deleteUser: (id: string) => req<{ ok: true }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
	resetPassword: (id: string, password: string) =>
		req<{ ok: true }>(`/api/admin/users/${id}/password`, {
			method: 'POST',
			body: JSON.stringify({ password }),
		}),

	uploadImage: async (blob: Blob, filename = 'image.webp') => {
		const fd = new FormData();
		fd.append('img', blob, filename);
		return req<{
			showUrl: string;
			thumbUrl: string;
			fullUrl?: string;
			width: number;
			height: number;
		}>('/api/upload', {
			method: 'POST',
			body: fd,
		});
	},
};
