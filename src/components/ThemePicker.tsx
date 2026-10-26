import { useEffect, useRef, useState } from 'react';
import { Check, Palette, X } from 'lucide-react';
import { THEMES, type Theme } from '../lib/themes';

interface Props {
	value: string;
	onChange: (id: string) => void;
}

/** Small swatch row that hints at a theme's colors. */
function Swatches({ theme }: { theme: Theme }) {
	return (
		<div className="theme-card__swatches">
			{theme.swatches.slice(0, 5).map((c) => (
				<span key={c} style={{ background: c }} />
			))}
		</div>
	);
}

/**
 * Theme picker panel: a compact popover with a card per palette, each card
 * previewing the canvas, node tones and accent color.
 */
export default function ThemePicker({ value, onChange }: Props) {
	const [open, setOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const active = THEMES.find((t) => t.id === value) ?? THEMES[0];

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
				title="切换配色主题"
			>
				<Palette size={15} strokeWidth={1.9} />
				{active.name}
			</button>

			{open ? (
				<div className="theme-panel">
					<div className="theme-panel__head">
						<span>配色主题</span>
						<button className="icon-btn" onClick={() => setOpen(false)} title="关闭">
							<X size={15} strokeWidth={2} />
						</button>
					</div>

					<div className="theme-panel__grid">
						{THEMES.map((t) => (
							<button
								key={t.id}
								className={`theme-card${t.id === value ? ' is-active' : ''}`}
								onClick={() => {
									onChange(t.id);
									setOpen(false);
								}}
								title={t.name}
							>
								<div
									className="theme-card__preview"
									style={{ background: t.canvas, borderColor: t.leaf.border }}
								>
									<span className="theme-card__root" style={{ background: t.root.bg }}>
										<span className="theme-card__dot" style={{ background: t.root.text }} />
									</span>
									<span
										className="theme-card__branch"
										style={{ background: t.branch.bg, borderColor: t.branch.border }}
									/>
									<span
										className="theme-card__leaf"
										style={{ background: t.leaf.bg, borderColor: t.leaf.border }}
									/>
									{t.id === value ? (
										<span className="theme-card__check">
											<Check size={11} strokeWidth={3} />
										</span>
									) : null}
								</div>
								<span className="theme-card__name">{t.name}</span>
								<Swatches theme={t} />
							</button>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
