/**
 * The mind-map type icon (user-provided artwork), served as a static asset
 * from `public/mind-icon.svg` — the source paths are long, so referencing the
 * file keeps the bundle small and the artwork byte-identical.
 */
export default function MindLogo({ size = 14, className }: { size?: number; className?: string }) {
	return (
		<img
			src="/mind-icon.svg"
			width={size}
			height={size}
			alt=""
			draggable={false}
			className={className}
			style={{ flexShrink: 0, display: 'block' }}
		/>
	);
}
