// The "Diff colors" setting (diffColorScheme: "red-green" | "blue-orange"), ported from the
// reference's index.css `:root[data-diff-color-scheme="blue-orange"]` blocks (~L1294, ~L2299),
// which repoint --diff-addition(-foreground) and --diff-deletion(-foreground) from
// emerald/red to blue/orange everywhere those tokens are consumed (diff stats, the changed-files
// card, the thread details "Changes" row, PR stats, file tree status marks).
//
// The port has no per-request CSS custom properties, so instead of a document attribute this
// reads the setting signal directly (settingValue is reactive) and returns the matching Tailwind
// class string. Every consumer calls this inside its own reactive render body, so flipping the
// setting recolors everything live, with no rebuild or restart.
import type { DiffViewClasses } from "nsh/base";
import { settingValue } from "../../store";

export function diffColorSchemeIsBlueOrange(): boolean {
  return settingValue("diffColorScheme") === "blue-orange";
}

// text-diff-addition-foreground: reference default light-dark(emerald-700, emerald-400);
// blue-orange: light-dark(blue-600, blue-400) (index.css L2300, L2302).
export function diffAdditionClass(defaultClass: string): string {
  return diffColorSchemeIsBlueOrange() ? "text-blue-600 dark:text-blue-400" : defaultClass;
}

// text-diff-deletion-foreground: reference default light-dark(red-700, red-400);
// blue-orange: light-dark(orange-600, orange-400) (index.css L2301, L2303).
export function diffDeletionClass(defaultClass: string): string {
  return diffColorSchemeIsBlueOrange() ? "text-orange-600 dark:text-orange-400" : defaultClass;
}

// A diff row's background wash for DiffView's `classes.lineAdded` / `lineDeleted`. The reference
// mixes --diff-addition into --code-background at 50%/70% (diffRendering.ts L293-296); NSH
// squares Tailwind's alpha modifiers on generated tokens, so this uses a solid low-saturation
// shade of the scheme's hue instead of a percentage mix. `defaultClass` keeps DiffView's native
// green/red tint (its built-in default) untouched for red-green.
export function diffAdditionBgClass(defaultClass: string | undefined): string | undefined {
  return diffColorSchemeIsBlueOrange() ? "bg-blue-50 dark:bg-blue-950" : defaultClass;
}

export function diffDeletionBgClass(defaultClass: string | undefined): string | undefined {
  return diffColorSchemeIsBlueOrange() ? "bg-orange-50 dark:bg-orange-950" : defaultClass;
}

// A changed word's background: a step stronger than its line (the reference's word emphasis
// mixes at 80% vs. the line's 50/70%, diffRendering.ts L293-306 vs L302-306: "a stronger green"/
// "a stronger red" per base.d.ts's DiffViewClasses.wordAdded/wordDeleted doc comments).
export function diffAdditionWordBgClass(defaultClass: string | undefined): string | undefined {
  return diffColorSchemeIsBlueOrange() ? "bg-blue-100 dark:bg-blue-900" : defaultClass;
}

export function diffDeletionWordBgClass(defaultClass: string | undefined): string | undefined {
  return diffColorSchemeIsBlueOrange() ? "bg-orange-100 dark:bg-orange-900" : defaultClass;
}

// A gutter indicator (indicators="bars": a filled bar; "classic": a +/- glyph, which is text).
// Carrying both a solid fill and a text color covers whichever the native widget draws.
export function diffAdditionIndicatorClass(defaultClass: string | undefined): string | undefined {
  return diffColorSchemeIsBlueOrange() ? "bg-blue-600 dark:bg-blue-400 text-blue-600 dark:text-blue-400" : defaultClass;
}

export function diffDeletionIndicatorClass(defaultClass: string | undefined): string | undefined {
  return diffColorSchemeIsBlueOrange() ? "bg-orange-600 dark:bg-orange-400 text-orange-600 dark:text-orange-400" : defaultClass;
}

// --diff-modified-icon: in blue-orange, blue is spent on additions, so the reference mutes the
// "modified" mark to --muted-foreground instead of its usual info blue (index.css L1294-1301).
export function diffModifiedClass(defaultClass: string): string {
  return diffColorSchemeIsBlueOrange() ? "text-muted-foreground" : defaultClass;
}

/** Every `DiffView` (the whole-file/stacked diff, the PR Code tab, the Guide tab's excerpts)
 * shares this: `undefined` keeps DiffView's own green/red default for red-green, and every
 * added/deleted surface (row tint, word tint, gutter number, indicator) switches to blue/orange
 * together for blue-orange. Call it fresh in each reactive render -- it is not itself a signal. */
export function diffViewColorClasses(): DiffViewClasses | undefined {
  if (!diffColorSchemeIsBlueOrange()) return {
    side: "bg-background", gutter: "bg-background", content: "bg-background",
    lineAdded: "bg-emerald-500/10", lineDeleted: "bg-red-500/10",
    wordAdded: "bg-emerald-500/20", wordDeleted: "bg-red-500/20",
    separator: "bg-background",
  };
  return {
    lineAdded: diffAdditionBgClass(undefined), lineDeleted: diffDeletionBgClass(undefined),
    wordAdded: diffAdditionWordBgClass(undefined), wordDeleted: diffDeletionWordBgClass(undefined),
    lineNumberAdded: diffAdditionClass(""), lineNumberDeleted: diffDeletionClass(""),
    indicatorAdded: diffAdditionIndicatorClass(undefined), indicatorDeleted: diffDeletionIndicatorClass(undefined),
  };
}
