import { useCallback, useRef, useState } from 'react';
import type { Edge } from '@xyflow/react';
import type { MindNode } from './types';

export interface Snapshot {
	nodes: MindNode[];
	edges: Edge[];
}

export interface History {
	canUndo: boolean;
	canRedo: boolean;
	undo: () => void;
	redo: () => void;
	/** Record the state BEFORE a mutation. Call at the start of each edit. */
	push: (snap: Snapshot) => void;
	/** Clear the stacks (e.g. after loading a different map). */
	reset: () => void;
}

const LIMIT = 80;

/**
 * Undo/redo over {nodes, edges} snapshots.
 *
 * `push` stores the state *before* a mutation, so `undo` restores the previous
 * entry while moving the live state onto the redo stack. `getCurrent` supplies
 * that live state, which is why it is a getter rather than a value.
 *
 * The stack *lengths* live in React state so the toolbar buttons re-render when
 * availability changes; the snapshots themselves stay in refs to avoid copying
 * large arrays on every keystroke.
 */
export function useHistory(getCurrent: () => Snapshot, apply: (snap: Snapshot) => void): History {
	const past = useRef<Snapshot[]>([]);
	const future = useRef<Snapshot[]>([]);
	const [counts, setCounts] = useState({ past: 0, future: 0 });

	const sync = () => setCounts({ past: past.current.length, future: future.current.length });

	const clone = (s: Snapshot): Snapshot => ({
		nodes: s.nodes.map((n) => ({ ...n, data: { ...n.data } })),
		edges: s.edges.map((e) => ({ ...e })),
	});

	const push = useCallback((snap: Snapshot) => {
		past.current.push(clone(snap));
		if (past.current.length > LIMIT) past.current.shift();
		future.current = [];
		sync();
	}, []);

	const undo = useCallback(() => {
		if (!past.current.length) return;
		future.current.push(clone(getCurrent()));
		const prev = past.current.pop()!;
		apply(prev);
		sync();
	}, [apply, getCurrent]);

	const redo = useCallback(() => {
		if (!future.current.length) return;
		past.current.push(clone(getCurrent()));
		const next = future.current.pop()!;
		apply(next);
		sync();
	}, [apply, getCurrent]);

	const reset = useCallback(() => {
		past.current = [];
		future.current = [];
		sync();
	}, []);

	return {
		canUndo: counts.past > 0,
		canRedo: counts.future > 0,
		undo,
		redo,
		push,
		reset,
	};
}
