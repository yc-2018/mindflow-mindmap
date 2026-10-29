import { createContext, useContext } from 'react';
import { DEFAULT_THEME_ID, getTheme, type Theme } from './themes';

const ThemeContext = createContext<Theme>(getTheme(DEFAULT_THEME_ID));

export const ThemeProvider = ThemeContext.Provider;

/** Read the active theme. Nodes and edges use it for their colors. */
export function useTheme(): Theme {
	return useContext(ThemeContext);
}

/**
 * Read-only flag for the whole canvas.
 *
 * The shared view renders the same node/edge components as the editor, so those
 * components need to know whether editing affordances (delete buttons, in-place
 * text editing, collapse toggles) should be shown. Threading a prop through
 * React Flow's nodeTypes/edgeTypes is not possible, hence a context.
 */
const ReadOnlyContext = createContext(false);

export const ReadOnlyProvider = ReadOnlyContext.Provider;

export function useReadOnly(): boolean {
	return useContext(ReadOnlyContext);
}
