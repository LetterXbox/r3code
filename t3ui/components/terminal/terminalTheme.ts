// What the terminal page gets for the theme (terminalThemeFromApp in ThreadTerminalDrawer.tsx): the three colours of the app's
// terminal tokens, the 16 ANSI colours of the light or dark palette, and the selection colour. The page was given only the three
// colours, so ANSI output used the renderer's own defaults and a selection its default tint.

/** TERMINAL_PALETTES of ThreadTerminalDrawer.tsx. */
export const TERMINAL_PALETTES = {
  light: [
    "#000000", "#cd3131", "#107c10", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
    "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5",
  ],
  dark: [
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
  ],
} as const;

export interface TerminalThemeMessage {
  type: "theme";
  background: string;
  foreground: string;
  cursor: string;
  palette: readonly string[];
  /** A CSS colour, or "" to keep the renderer's default. */
  selection: string;
}

/** The message that carries the app's terminal tokens to the page; `scheme` picks the ANSI palette. */
export function terminalThemeMessage(tokens: { background: string; foreground: string; cursor: string; selection?: string }, scheme: "light" | "dark"): TerminalThemeMessage {
  return { type: "theme", ...tokens, palette: TERMINAL_PALETTES[scheme], selection: tokens.selection ?? "" };
}
