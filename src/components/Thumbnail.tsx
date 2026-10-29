import { memo, useMemo } from 'react';
import { parseDoc, type MindNode } from '../lib/types';
import { estimateHeight, NODE_WIDTH, pruneEdges, layoutTree, syncTones } from '../lib/layout';
import { getStructure } from '../lib/structures';

const PAD = 28;

interface Props {
	data: string;
}

interface Box {
	node: MindNode;
	w: number;
	h: number;
}

/**
 * Lightweight SVG preview of a mind map. Deliberately not a ReactFlow instance:
 * a dashboard can hold dozens of cards, and mounting one flow per card is far too heavy.
 */
function Thumbnail({ data }: Props) {
	const model = useMemo(() => {
		const doc = parseDoc(data);
		if (!doc.nodes.length) return null;

		/**
		 * Use the SAME layout the editor and the shared view use.
		 *
		 * The thumbnail used to draw the raw stored coordinates. Since the editor
		 * re-runs the layout on load, a card could show a completely different
		 * arrangement from the map itself — the reported "首页缩略图看到的也不一样".
		 */
		const pruned = pruneEdges(doc.nodes, doc.edges);
		const toned = syncTones(doc.nodes, pruned);
		const nodes = layoutTree(toned, pruned, getStructure(doc.structure));
		const edges = pruned;

		const boxes: Box[] = nodes.map((n) => ({ node: n, w: NODE_WIDTH, h: estimateHeight(n) }));

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const b of boxes) {
			minX = Math.min(minX, b.node.position.x);
			minY = Math.min(minY, b.node.position.y);
			maxX = Math.max(maxX, b.node.position.x + b.w);
			maxY = Math.max(maxY, b.node.position.y + b.h);
		}
		if (!Number.isFinite(minX)) return null;

		const w = Math.max(1, maxX - minX);
		const h = Math.max(1, maxY - minY);

		const byId = new Map(boxes.map((b) => [b.node.id, b]));
		const lines = edges
			.map((e) => {
				const s = byId.get(e.source);
				const t = byId.get(e.target);
				if (!s || !t) return null;
				return {
					id: e.id,
					x1: s.node.position.x + s.w,
					y1: s.node.position.y + s.h / 2,
					x2: t.node.position.x,
					y2: t.node.position.y + t.h / 2,
				};
			})
			.filter(Boolean) as { id: string; x1: number; y1: number; x2: number; y2: number }[];

		return { boxes, lines, w, h, minX, minY };
	}, [data]);

	if (!model) {
		return (
			<div className="thumb thumb--empty">
				<span>空白导图</span>
			</div>
		);
	}

	const vbW = model.w + PAD * 2;
	const vbH = model.h + PAD * 2;

	return (
		<div className="thumb">
			<svg
				viewBox={`${model.minX - PAD} ${model.minY - PAD} ${vbW} ${vbH}`}
				preserveAspectRatio="xMidYMid meet"
				role="img"
				aria-label="导图预览"
			>
				{model.lines.map((e) => {
					const mx = (e.x1 + e.x2) / 2;
					return (
						<path
							key={e.id}
							d={`M${e.x1},${e.y1} C${mx},${e.y1} ${mx},${e.y2} ${e.x2},${e.y2}`}
							stroke="#cbd5e1"
							strokeWidth={2}
							fill="none"
						/>
					);
				})}

				{model.boxes.map(({ node, w, h }) => {
					const tone = node.data.tone ?? 'leaf';
					const fill =
						tone === 'root' ? '#34c48b' : tone === 'branch' ? '#eef2ff' : '#ffffff';
					const stroke = tone === 'root' ? '#2fae7a' : tone === 'branch' ? '#c7d2fe' : '#e2e8f0';
					const textColor = tone === 'root' ? '#ffffff' : '#334155';
					const label = node.data.label || '主题';
					const lines = Math.max(1, Math.ceil(label.length / 9));
					const textH = lines * 22 + 18;

					return (
						<g key={node.id} transform={`translate(${node.position.x},${node.position.y})`}>
							<rect
								width={w}
								height={h}
								rx={12}
								fill={fill}
								stroke={stroke}
								strokeWidth={1.5}
							/>
							<text
								x={12}
								y={22}
								fontSize={13}
								fill={textColor}
								fontWeight={tone === 'root' ? 600 : 500}
							>
								{label.slice(0, 18)}
								{label.length > 18 ? '…' : ''}
							</text>
							{(node.data.images?.length ?? 0) > 0 ? (
								<rect
									x={10}
									y={textH}
									width={w - 20}
									height={Math.min(56, h - textH - 8)}
									rx={6}
									fill="#e8ecf5"
									stroke="#dde3ee"
								/>
							) : null}
						</g>
					);
				})}
			</svg>
		</div>
	);
}

export default memo(Thumbnail);
