import { useEffect, useState } from 'react';

export function usePathname(): string {
	const [path, setPath] = useState(() => window.location.pathname);
	useEffect(() => {
		const onPop = () => setPath(window.location.pathname);
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	}, []);
	return path;
}

export function navigate(to: string, replace = false): void {
	if (replace) window.history.replaceState({}, '', to);
	else window.history.pushState({}, '', to);
	window.dispatchEvent(new PopStateEvent('popstate'));
}
