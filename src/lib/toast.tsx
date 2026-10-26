import { useEffect, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

interface Toast {
	id: number;
	kind: ToastKind;
	message: string;
}

type Listener = (t: Toast) => void;

const listeners = new Set<Listener>();
let seq = 1;

export function toast(message: string, kind: ToastKind = 'info'): void {
	const t: Toast = { id: seq++, kind, message };
	for (const l of listeners) l(t);
}

export function useToasts(): Toast[] {
	const [items, setItems] = useState<Toast[]>([]);
	useEffect(() => {
		const listener: Listener = (t) => {
			setItems((prev) => [...prev, t]);
			setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 2600);
		};
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);
	return items;
}

export function Toaster() {
	const items = useToasts();
	if (!items.length) return null;
	return (
		<div className="toaster">
			{items.map((t) => (
				<div key={t.id} className={`toast toast-${t.kind}`}>
					{t.message}
				</div>
			))}
		</div>
	);
}
