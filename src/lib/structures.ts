import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';

/**
 * Mind-map "structures" (骨架).
 *
 * Each one lays the same tree out differently. The user picks a structure per
 * document; `balanced` is the classic left-to-right layout and stays default.
 */
export type StructureId =
	| 'balanced' // 思维导图: root left, children fan right
	| 'right' // 向右树形图
	| 'left' // 向左树形图
	| 'down' // 向下组织结构图
	| 'up' // 向上组织结构图
	| 'both' // 两侧平衡（左右各半）
	| 'fishbone'; // 鱼骨图

export interface StructureMeta {
	id: StructureId;
	name: string;
	/** Group heading in the picker. */
	group: string;
}

export const STRUCTURES: StructureMeta[] = [
	{ id: 'balanced', name: '思维导图', group: '骨架' },
	{ id: 'right', name: '向右树形图', group: '树形图' },
	{ id: 'left', name: '向左树形图', group: '树形图' },
	{ id: 'down', name: '向下组织结构图', group: '组织结构图' },
	{ id: 'up', name: '向上组织结构图', group: '组织结构图' },
	{ id: 'both', name: '两侧平衡图', group: '括号图' },
	{ id: 'fishbone', name: '鱼骨图', group: '鱼骨图' },
];

export const DEFAULT_STRUCTURE: StructureId = 'balanced';

export function getStructure(id: string | undefined | null): StructureId {
	return (STRUCTURES.find((s) => s.id === id)?.id ?? DEFAULT_STRUCTURE) as StructureId;
}

/** Which side a structure places children on, used for handle selection. */
export type Direction = 'right' | 'left' | 'down' | 'up';

export function directionFor(structure: StructureId, node?: MindNode): Direction {
	switch (structure) {
		case 'left':
			return 'left';
		case 'down':
			return 'down';
		case 'up':
			return 'up';
		case 'both':
			// balanced on both sides: nodes carry their own side flag
			return node?.data?.side === 'left' ? 'left' : 'right';
		case 'fishbone':
			// the fishbone grows right: the head is on the left and the bones
			// lean toward the tail. Side flags are meaningless here — the layout
			// alternates branches above/below the spine by their order.
			return 'right';
		case 'right':
		case 'balanced':
		default:
			return 'right';
	}
}
