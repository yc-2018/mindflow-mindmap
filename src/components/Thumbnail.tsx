import { memo, useMemo } from 'react';
import { parseDoc, docKind, type MindNode } from '../lib/types';
import MarkdownRenderer from './MarkdownRenderer';
import { estimateHeight, NODE_WIDTH, pruneEdges, layoutTree, syncTones } from '../lib/layout';
import { getStructure } from '../lib/structures';
import { withAdaptiveHandles } from '../lib/handles';
import { pickPath } from './MindEdge';
import { Position } from '@xyflow/react';

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
	const kind = useMemo(() => docKind(parseDoc(data)), [data]);

	/**
	 * Markdown documents preview with the REAL renderer, not stripped text.
	 *
	 * The old version removed every marker with a regex, which also removed the
	 * `==highlight==` markers — so the card showed flat text and lost the very
	 * thing that makes the document readable at a glance. Rendering the first
	 * chunk through `MarkdownRenderer` keeps highlights, bold and headings.
	 *
	 * The excerpt stops at the first horizontal rule or after ~12 lines so a long
	 * note does not overflow the card.
	 */
	const mdPreview = useMemo(() => {
		if (kind !== 'md') return null;
		const doc = parseDoc(data);
		const src = (doc.markdown ?? '').trim();
		if (!src) return '';
		const lines = src.split('\n');
		const cut: string[] = [];
		for (const line of lines) {
			cut.push(line);
			if (cut.length >= 12) break;
		}
		return cut.join('\n');
	}, [data, kind]);

	/**
	 * draw.io diagrams preview with their real shape labels.
	 *
	 * The regex used to read `value="..."` from the raw XML and display it
	 * verbatim — but a self-closing/edge cell can carry an XML-escaped payload,
	 * and the card ended up looking like a dump of markup. Decoding entities and
	 * dropping empty/edge cells fixes that; only vertex labels are shown.
	 */
	const drawioPreview = useMemo(() => {
		if (kind !== 'drawio') return null;
		const doc = parseDoc(data);
		const xml = doc.drawioXml ?? '';

		const decode = (s: string) =>
			s
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")
				.replace(/&amp;/g, '&');

		const labels: string[] = [];
		// only cells that are VERTICES (shapes), never edges
		const re = /<mxCell[^>]*\bvertex="1"[^>]*\bvalue="([^"]*)"|<mxCell[^>]*\bvalue="([^"]*)"[^>]*\bvertex="1"/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(xml)) && labels.length < 6) {
			const raw = m[1] ?? m[2] ?? '';
			const v = decode(raw)
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();
			if (v && !v.startsWith('<')) labels.push(v);
		}
		return labels;
	}, [data, kind]);

	const model = useMemo(() => {
		if (kind !== 'mind') return null;
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

		/**
		 * Draw the connectors with the SAME code path as the editor: route the
		 * handles first, then turn each routed edge into a path with pickPath.
		 *
		 * The thumbnail used to draw its own bezier (right edge -> left edge),
		 * which ignores the fishbone's spine/bones/ribs entirely — a fishbone
		 * card showed a curly generic mind map while the editor showed a fish
		 * ("首页的缩略图和里面的图不太像"). With the shared router the thumbnail
		 * now mirrors the editor line for line.
		 */
		const routed = withAdaptiveHandles(nodes, pruned, getStructure(doc.structure));
		const paths = routed
			.map((e) => {
				const s = byId.get(e.source);
				const t = byId.get(e.target);
				if (!s || !t) return null;
				const sourceHandleId = e.sourceHandle ?? undefined;
				const targetHandleId = e.targetHandle ?? undefined;
				// map handle ids onto the node-edge anchor points, exactly where
				// React Flow would place them on the real handles
				const anchor = (
					box: Box,
					handleId: string | undefined,
					fallback: 'left' | 'right',
				): { x: number; y: number; position: Position } => {
					const cx = box.node.position.x + box.w / 2;
					const cy = box.node.position.y + box.h / 2;
					if (handleId?.endsWith('-bottom'))
						return { x: cx, y: box.node.position.y + box.h, position: Position.Bottom };
					if (handleId?.endsWith('-top'))
						return { x: cx, y: box.node.position.y, position: Position.Top };
					if (handleId?.endsWith('-left'))
						return { x: box.node.position.x, y: cy, position: Position.Left };
					return {
						x: fallback === 'left' ? box.node.position.x : box.node.position.x + box.w,
						y: cy,
						position: fallback === 'left' ? Position.Left : Position.Right,
					};
				};
				const a = anchor(s, sourceHandleId, 'right');
				const b = anchor(t, targetHandleId, 'left');
				const fish = (e.data as { fishbone?: 'bone' | 'rib' | null } | undefined)?.fishbone;
				const { path } = pickPath({
					sourceX: a.x,
					sourceY: a.y,
					sourcePosition: a.position,
					sourceHandleId,
					targetX: b.x,
					targetY: b.y,
					targetPosition: b.position,
					targetHandleId,
					fishbone: fish ?? null,
				});
				return { id: e.id, d: path };
			})
			.filter(Boolean) as { id: string; d: string }[];

		return { boxes, paths, w, h, minX, minY };
	}, [data]);

	if (kind === 'md') {
		return (
			<div className="thumb thumb--md">
				<div className="thumb__md-render md-label">
					<MarkdownRenderer source={mdPreview || '*空白文档*'} />
				</div>
			</div>
		);
	}

	if (kind === 'drawio') {
		return (
			<div className="thumb thumb--text">
				{(drawioPreview ?? []).map((label, i) => (
					<span key={i} className={`thumb__line thumb__chip${i === 0 ? ' thumb__chip--first' : ''}`}>
						{label}
					</span>
				))}
				{(drawioPreview ?? []).length === 0 ? <span className="thumb__empty-note">空白图表</span> : null}
			</div>
		);
	}

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
				{model.paths.map((e) => (
					<path key={e.id} d={e.d} stroke="#cbd5e1" strokeWidth={2} fill="none" />
				))}

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
