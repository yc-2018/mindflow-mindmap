import { useSyncExternalStore } from 'react';

/**
 * The auto-save preference, shared by all editors (mind / md / drawio).
 *
 * On by default. Turning it OFF switches an editor into manual mode: changes
 * are still held in memory (and flagged dirty), but nothing is written until
 * the user presses 保存 / Ctrl+S.
 *
 * Stored in localStorage so the choice survives reloads and applies to every
 * document — the user asked for one visible switch, per editor, defaulting on.
 */
const KEY = 'mindfl…save';

let current = true;
try {
	current = localStorage.getItem(KEY) !== 'off';
} catch {
	/* private mode: just keep the default */
}

const listeners = new Set<() => void>();

export function getAutoSave(): boolean {
	return current;
}

export function setAutoSave(on: boolean): void {
	current = on;
	try {
		localStorage.setItem(KEY, on ? 'on' : 'off');
	} catch {
		/* ignore quota / private mode */
	}
	for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** Reactive read of the preference; re-renders subscribers on change. */
export function useAutoSave(): boolean {
	return useSyncExternalStore(subscribe, getAutoSave, getAutoSave);
}
