import { useEffect, useState } from 'react';
import {
	Background,
	BackgroundVariant,
	Controls,
	ReactFlow,
	ReactFlowProvider,
	type Edge,
} from '@xyflow/react';
import { House, Link2Off } from 'lucide-react';
import '@xyflow/react/dist/style.css';

import MindNodeView from '../components/MindNodeView';
import MindEdge from '../components/MindEdge';
import { api } from '../lib/api';
import { parseDoc, type MindNode } from '../lib/types';
import { pruneEdges, layoutTree, syncTones } from '../lib/layout';
import { getStructure } from '../lib/structures';
import { childCounts } from '../lib/visibility';
import { navigate } from '../lib/router';

const nodeTypes = { mind: MindNodeView };
const edgeTypes = { mind: MindEdge };

function SharedInner({ token }: { token: string }) {
	const [title, setTitle] = useState('');
	const [nodes, setNodes] = useState<MindNode[]>([]);
	const [edges, setEdges] = useState<Edge[]>([]);
	const [state, setState] = useState<'loading' | 'ok' | 'missing'>('loading');

	useEffect(() => {
		api
			.getShared(token)
			.then(({ map }) => {
				setTitle(map.title);
				const doc = parseDoc(map.data);
				const pruned = pruneEdges(doc.nodes, doc.edges);

				/**
				 * Run the SAME layout pipeline the editor uses.
				 *
				 * Rendering the stored coordinates directly made a shared map look
				 * different from what the owner sees: the editor re-runs `layoutTree`
				 * on load, so any coordinates that were saved before a later layout
				 * change no longer matched. Recomputing here guarantees the viewer
				 * sees exactly the arrangement the editor shows.
				 */
				const toned = syncTones(doc.nodes, pruned);
				const counts = childCounts(toned, pruned);
				const withCounts = toned.map((n) => ({
					...n,
					data: { ...n.data, childCount: counts.get(n.id) ?? 0 },
				}));
				const laidOut = layoutTree(withCounts, pruned, getStructure(doc.structure));

				setNodes(laidOut);
				setEdges(pruned);
				setState('ok');
			})
			.catch(() => setState('missing'));
	}, [token]);

	if (state === 'loading') {
		return (
			<div className="boot">
				<div className="spinner" />
			</div>
		);
	}

	if (state === 'missing') {
		return (
			<div className="boot">
				<div className="shared-missing">
					<div className="shared-missing__icon">
						<Link2Off size={40} strokeWidth={1.3} />
					</div>
					<h2>分享链接无效</h2>
					<p>该链接可能已被关闭或不存在。</p>
					<button className="btn-primary btn-icon-text" onClick={() => navigate('/')}>
						<House size={16} strokeWidth={1.9} />
						返回首页
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="editor">
			<header className="editor__bar">
				<div className="editor__left">
					<span className="editor__title shared-title">{title}</span>
					<span className="save-state">只读分享</span>
				</div>
				<div className="editor__right">
					<button className="btn-ghost btn-icon-text" onClick={() => navigate('/')}>
						<House size={15} strokeWidth={1.9} />
						返回首页
					</button>
				</div>
			</header>
			<div className="editor__canvas">
				<ReactFlow
					<MindNode, Edge>
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					fitView
					minZoom={0.15}
					maxZoom={2.5}
					proOptions={{ hideAttribution: true }}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
				>
					<Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d8dbe6" />
					<Controls showInteractive={false} />
				</ReactFlow>
			</div>
		</div>
	);
}

export default function SharedView({ token }: { token: string }) {
	return (
		<ReactFlowProvider>
			<SharedInner token={token} />
		</ReactFlowProvider>
	);
}
