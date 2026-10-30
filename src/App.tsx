import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type User } from './lib/api';
import { navigate, usePathname } from './lib/router';
import { Toaster, toast } from './lib/toast';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Admin from './pages/Admin';
import Editor from './pages/Editor';
import SharedView from './pages/SharedView';

export default function App() {
	const path = usePathname();
	const [user, setUser] = useState<User | null>(null);
	const [checking, setChecking] = useState(true);

	// route classification
	const mapMatch = path.match(/^\/map\/([A-Za-z0-9]+)$/);
	const shareMatch = path.match(/^\/s\/([A-Za-z0-9]+)$/);
	const isAdminPage = path === '/admin';
	const isRegisterPage = path === '/register';

	useEffect(() => {
		api
			.me()
			.then(({ user: u }) => setUser(u))
			.catch((err) => {
				if (!(err instanceof ApiError) || err.status !== 401) toast('会话检查失败', 'error');
			})
			.finally(() => setChecking(false));
	}, []);

	const logout = useCallback(async () => {
		await api.logout().catch(() => undefined);
		setUser(null);
		navigate('/');
	}, []);

	// public shared view — no auth required
	if (shareMatch) {
		return (
			<>
				<SharedView token={shareMatch[1]} />
				<Toaster />
			</>
		);
	}

	if (checking) {
		return (
			<div className="boot">
				<div className="spinner" />
			</div>
		);
	}

	if (!user) {
		return (
			<>
				{isRegisterPage ? (
					<Register
						onSuccess={(u) => {
							setUser(u);
							navigate('/');
						}}
					/>
				) : (
					<Login
						onSuccess={(u) => {
							setUser(u);
							navigate('/');
						}}
					/>
				)}
				<Toaster />
			</>
		);
	}

	let content: React.ReactNode;
	if (mapMatch) content = <Editor mapId={mapMatch[1]} />;
	else if (isAdminPage) content = user.role === 'admin' ? <Admin user={user} /> : <Dashboard user={user} onLogout={logout} />;
	else content = <Dashboard user={user} onLogout={logout} />;

	return (
		<>
			{content}
			<Toaster />
		</>
	);
}
