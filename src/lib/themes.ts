/** Visual themes for the mind map. */

export interface Theme {
	id: string;
	/** Display name in the picker. */
	name: string;
	/** Swatch shown in the palette row (the 8 accent colors). */
	swatches: string[];
	/** Background of the canvas. */
	canvas: string;
	/** Dot grid color on the canvas. */
	grid: string;
	root: { bg: string; border: string; text: string };
	branch: { bg: string; border: string; text: string };
	leaf: { bg: string; border: string; text: string };
	edge: { stroke: string; active: string; label: string };
	/** Accent used for controls, selection rings, minimap. */
	accent: string;
}

export const THEMES: Theme[] = [
	{
		id: 'classic',
		name: '经典推荐',
		swatches: ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#3b82f6', '#6366f1', '#a855f7', '#1e293b'],
		canvas: '#fbfbfd',
		grid: '#d8dbe6',
		root: { bg: '#34c48b', border: '#2fae7a', text: '#ffffff' },
		branch: { bg: '#f7f8ff', border: '#d9dffb', text: '#1e2432' },
		leaf: { bg: '#ffffff', border: '#e6e9f0', text: '#1e2432' },
		edge: { stroke: '#cbd5e1', active: '#818cf8', label: '#6b7488' },
		accent: '#6366f1',
	},
	{
		id: 'vivid',
		name: '彩色分支',
		swatches: ['#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'],
		canvas: '#fdfdff',
		grid: '#e4e7f0',
		root: { bg: '#f97316', border: '#ea580c', text: '#ffffff' },
		branch: { bg: '#fff7ed', border: '#fed7aa', text: '#7c2d12' },
		leaf: { bg: '#ffffff', border: '#e8eaf2', text: '#1e2432' },
		edge: { stroke: '#fdba74', active: '#fb923c', label: '#9a3412' },
		accent: '#f97316',
	},
	{
		id: 'ocean',
		name: '深海蓝',
		swatches: ['#0ea5e9', '#38bdf8', '#22d3ee', '#14b8a6', '#6366f1', '#818cf8', '#a78bfa', '#1e3a8a'],
		canvas: '#f8fbfe',
		grid: '#d5e3f0',
		root: { bg: '#0ea5e9', border: '#0284c7', text: '#ffffff' },
		branch: { bg: '#f0f9ff', border: '#bae6fd', text: '#0c4a6e' },
		leaf: { bg: '#ffffff', border: '#e2ecf5', text: '#1e2432' },
		edge: { stroke: '#7dd3fc', active: '#0ea5e9', label: '#0369a1' },
		accent: '#0ea5e9',
	},
	{
		id: 'forest',
		name: '森林绿',
		swatches: ['#10b981', '#34d399', '#84cc16', '#22c55e', '#14b8a6', '#0d9488', '#65a30d', '#14532d'],
		canvas: '#f9fdfb',
		grid: '#d6e8dd',
		root: { bg: '#10b981', border: '#059669', text: '#ffffff' },
		branch: { bg: '#ecfdf5', border: '#a7f3d0', text: '#064e3b' },
		leaf: { bg: '#ffffff', border: '#e3ece7', text: '#1e2432' },
		edge: { stroke: '#6ee7b7', active: '#10b981', label: '#047857' },
		accent: '#10b981',
	},
	{
		id: 'rose',
		name: '暖玫红',
		swatches: ['#f43f5e', '#fb7185', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#f97316', '#831843'],
		canvas: '#fffbfc',
		grid: '#f0dbe1',
		root: { bg: '#f43f5e', border: '#e11d48', text: '#ffffff' },
		branch: { bg: '#fff1f2', border: '#fecdd3', text: '#881337' },
		leaf: { bg: '#ffffff', border: '#f2e4e8', text: '#1e2432' },
		edge: { stroke: '#fda4af', active: '#f43f5e', label: '#be123c' },
		accent: '#f43f5e',
	},
	{
		id: 'dark',
		name: '暗色模式',
		swatches: ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#22d3ee', '#fb923c', '#f8fafc'],
		canvas: '#171923',
		grid: '#2c3040',
		root: { bg: '#4f46e5', border: '#6366f1', text: '#ffffff' },
		branch: { bg: '#242938', border: '#3b4256', text: '#e5e9f5' },
		leaf: { bg: '#1e2230', border: '#333a4d', text: '#dfe4f0' },
		edge: { stroke: '#4a5165', active: '#818cf8', label: '#98a1b3' },
		accent: '#818cf8',
	},
	{
		id: 'mono',
		name: '极简黑白',
		swatches: ['#0f172a', '#334155', '#64748b', '#94a3b8', '#cbd5e1', '#e2e8f0', '#f1f5f9', '#ffffff'],
		canvas: '#fafafa',
		grid: '#e0e0e0',
		root: { bg: '#0f172a', border: '#020617', text: '#ffffff' },
		branch: { bg: '#f8fafc', border: '#e2e8f0', text: '#0f172a' },
		leaf: { bg: '#ffffff', border: '#e5e7eb', text: '#1e2432' },
		edge: { stroke: '#cbd5e1', active: '#64748b', label: '#64748b' },
		accent: '#334155',
	},
];

export const DEFAULT_THEME_ID = 'classic';

export function getTheme(id: string | undefined | null): Theme {
	return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
