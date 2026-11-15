// How the library lays custom themes out (ThemeSettings.tsx): themes of one community extension share a card with
// its variants, each other theme has its own, and variants are named by what they do not share.
import type { CustomTheme } from "./customThemes";

/** Custom themes grouped by collection (`collection:<id>`) or alone (`theme:<id>`), in the order they were first seen. */
export function groupCustomThemes(themes: ReadonlyArray<CustomTheme>): [string, CustomTheme[]][] {
  const groups = new Map<string, CustomTheme[]>();
  for (const theme of themes) {
    const key = theme.collection ? `collection:${theme.collection.id}` : `theme:${theme.id}`;
    const group = groups.get(key);
    if (group) group.push(theme);
    else groups.set(key, [theme]);
  }
  return [...groups.entries()];
}

/** The short name of each variant of a collection: its label without the words every variant starts with ("Dracula Soft" is "Soft"). */
export function collectionVariantLabels(themes: ReadonlyArray<{ label: string }>): string[] {
  if (themes.length === 0) return [];
  const words = themes.map((theme) => theme.label.trim().split(/\s+/));
  const firstWords = words[0]!;
  const sharedWordCount = firstWords.findIndex((word, index) => words.some((labelWords) => labelWords[index]?.toLocaleLowerCase() !== word.toLocaleLowerCase()));
  const prefixLength = sharedWordCount === -1 ? firstWords.length - 1 : sharedWordCount;
  return themes.map((theme, index) => {
    const shortLabel = words[index]?.slice(Math.max(0, prefixLength)).join(" ").trim();
    return shortLabel || theme.label;
  });
}
