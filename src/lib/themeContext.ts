import { createContext, useContext } from 'react';
import { DEFAULT_THEME_ID, getTheme, type Theme } from './themes';

const ThemeContext = createContext<Theme>(getTheme(DEFAULT_THEME_ID));

export const ThemeProvider = ThemeContext.Provider;

/** Read the active theme. Nodes and edges use it for their colors. */
export function useTheme(): Theme {
	return useContext(ThemeContext);
}
