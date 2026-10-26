/**
 * MindFlow brand mark: a compact mind-map glyph — one root node fanning out to
 * three children. Drawn by hand so the mark stays crisp at every size and does
 * not depend on an icon-font or emoji rendering.
 */
export function Logo({ size = 32 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-label="MindFlow">
			<rect width="32" height="32" rx="9" fill="url(#mf-grad)" />
			{/* connectors */}
			<path
				d="M11 16h5M16 16l5-6M16 16l5 6"
				stroke="rgba(255,255,255,0.55)"
				strokeWidth="1.6"
				strokeLinecap="round"
			/>
			{/* root node */}
			<circle cx="9" cy="16" r="3" fill="#fff" />
			{/* child nodes */}
			<circle cx="23" cy="9.5" r="2.4" fill="#fff" />
			<circle cx="23" cy="22.5" r="2.4" fill="#fff" />
			<defs>
				<linearGradient id="mf-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
					<stop stopColor="#6d6af5" />
					<stop offset="1" stopColor="#4f46e5" />
				</linearGradient>
			</defs>
		</svg>
	);
}
