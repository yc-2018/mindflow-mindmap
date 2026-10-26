import { useEffect, useRef, useState } from 'react';
import { Check, LayoutTemplate, X } from 'lucide-react';
import { STRUCTURES, type StructureId } from '../lib/structures';

interface Props {
	value: string;
	onChange: (id: StructureId) => void;
}

/**
 * Tiny SVG diagram that hints at how a structure arranges nodes.
 * Drawn inline so it stays crisp and needs no assets.
 */
function StructureIcon({ id }: { id: StructureId }) {
	const box = (x: number, y: number, w = 15, h = 9, fill = '#c7d2fe') => (
		<rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx={2.5} fill={fill} />
	);
	const line = (d: string) => (
		<path key={d} d={d} stroke="#cbd5e1" strokeWidth={1.2} fill="none" strokeLinecap="round" />
	);

	switch (id) {
		case 'balanced':
			return (
				<svg viewBox="0 0 60 34" className="struct-icon">
					{box(3, 12, 14, 10, '#34c48b')}
					{line('M17 17 h8')}
					{box(25, 6, 14, 8)}
					{box(25, 20, 14, 8)}
					{line('M39 10 h6')}
					{line('M39 24 h6')}
					{box(45, 3, 12, 7)}
					{box(45, 14, 12, 7)}
					{box(45, 25, 12, 7)}
				</svg>
			);
		case 'right':
			return (
				<svg viewBox="0 0 60 34" className="struct-icon">
					{box(3, 12, 13, 10, '#34c48b')}
					{line('M16 17 h6')}
					{box(22, 8, 12, 8)}
					{box(22, 20, 12, 8)}
					{line('M34 12 h6 M34 24 h6')}
					{box(40, 5, 12, 7)}
					{box(40, 16, 12, 7)}
					{box(40, 27, 12, 7)}
				</svg>
			);
		case 'left':
			return (
				<svg viewBox="0 0 60 34" className="struct-icon">
					{box(44, 12, 13, 10, '#34c48b')}
					{line('M44 17 h-6')}
					{box(26, 8, 12, 8)}
					{box(26, 20, 12, 8)}
					{line('M26 12 h-6 M26 24 h-6')}
					{box(8, 5, 12, 7)}
					{box(8, 16, 12, 7)}
					{box(8, 27, 12, 7)}
				</svg>
			);
		case 'down':
			return (
				<svg viewBox="0 0 60 34" className="struct-icon">
					{box(23, 2, 15, 9, '#34c48b')}
					{line('M30 11 v6')}
					{box(8, 17, 13, 8)}
					{box(24, 17, 13, 8)}
					{box(40, 17, 13, 8)}
					{line('M14 25 v4 M30 25 v4 M46 25 v4')}
					{box(8, 29, 11, 4)}
					{box(24, 29, 11, 4)}
					{box(41, 29, 11, 4)}
				</svg>
			);
		case 'up':
			return (
				<svg viewBox="0 0 60 34" className="struct-icon">
					{box(23, 23, 15, 9, '#34c48b')}
					{line('M30 23 v-6')}
					{box(8, 9, 13, 8)}
					{box(24, 9, 13, 8)}
					{box(40, 9, 13, 8)}
					{line('M14 9 v-4 M30 9 v-4 M46 9 v-4')}
					{box(8, 1, 11, 4)}
					{box(24, 1, 11, 4)}
					{box(41, 1, 11, 4)}
				</svg>
			);
		case 'both':
			return (
				<svg viewBox="0 0 60 34" className="struct-icon">
					{box(24, 12, 13, 10, '#34c48b')}
					{line('M24 14 h-6 M24 20 h-6')}
					{box(8, 6, 10, 7)}
					{box(8, 20, 10, 7)}
					{line('M36 14 h6 M36 20 h6')}
					{box(42, 6, 10, 7)}
					{box(42, 20, 10, 7)}
				</svg>
			);
		case 'fishbone':
			return (
				<svg viewBox="0 0 60 34" className="struct-icon">
					{box(2, 15, 12, 5, '#34c48b')}
					{line('M14 17.5 h42')}
					{line('M24 17.5 l-6 -9 M36 17.5 l-6 -9 M48 17.5 l-6 -9')}
					{box(15, 4, 9, 6)}
					{box(27, 4, 9, 6)}
					{box(39, 4, 9, 6)}
					{line('M24 17.5 l-6 9 M36 17.5 l-6 9 M48 17.5 l-6 9')}
					{box(15, 25, 9, 6)}
					{box(27, 25, 9, 6)}
					{box(39, 25, 9, 6)}
				</svg>
			);
		default:
			return null;
	}
}

/** Group structures for display, preserving declaration order. */
function grouped(): { group: string; items: typeof STRUCTURES }[] {
	const order: string[] = [];
	const map = new Map<string, typeof STRUCTURES>();
	for (const s of STRUCTURES) {
		if (!map.has(s.group)) {
			map.set(s.group, []);
			order.push(s.group);
		}
		map.get(s.group)!.push(s);
	}
	return order.map((g) => ({ group: g, items: map.get(g)! }));
}

/**
 * Structure picker: choose how the tree is laid out (mind map, org chart,
 * fishbone...). Mirrors the "骨架" panel of mature mind-map apps.
 */
export default function StructurePicker({ value, onChange }: Props) {
	const [open, setOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const active = STRUCTURES.find((s) => s.id === value) ?? STRUCTURES[0];

	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		document.addEventListener('mousedown', onClick);
		window.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onClick);
			window.removeEventListener('keydown', onKey);
		};
	}, [open]);

	return (
		<div className="theme-picker" ref={panelRef}>
			<button
				className="btn-ghost btn-icon-text"
				onClick={() => setOpen((v) => !v)}
				title="切换骨架结构"
			>
				<LayoutTemplate size={15} strokeWidth={1.9} />
				{active.name}
			</button>

			{open ? (
				<div className="theme-panel struct-panel">
					<div className="theme-panel__head">
						<span>骨架结构</span>
						<button className="icon-btn" onClick={() => setOpen(false)} title="关闭">
							<X size={15} strokeWidth={2} />
						</button>
					</div>

					{grouped().map(({ group, items }) => (
						<div key={group} className="struct-group">
							<div className="struct-group__title">{group}</div>
							<div className="struct-grid">
								{items.map((s) => (
									<button
										key={s.id}
										className={`struct-card${s.id === value ? ' is-active' : ''}`}
										onClick={() => {
											onChange(s.id);
											setOpen(false);
										}}
										title={s.name}
									>
										<StructureIcon id={s.id} />
										<span className="struct-card__name">{s.name}</span>
										{s.id === value ? (
											<span className="struct-card__check">
												<Check size={10} strokeWidth={3} />
											</span>
										) : null}
									</button>
								))}
							</div>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
