// The theme editor's rules, ported from ThemeEditorPanel.tsx: the colour families the editor groups the roles
// into, the simple mode (two colours, the rest derived), how a draft becomes a saved theme (a new one, an edit, or
// a merge into a theme of the same name that lacks the other appearance's palette) and the reasons an appearance
// is locked. Pure: the dialog (ThemeEditor.tsx) holds the draft and applies what `planThemeSave` returns.
import { themeIdFromName, THEME_FILE_VERSION, parseThemeFile } from "./themeFile";
import {
  createVividThemeColors, getStandardThemeColors, getThemeModes, isThemeColor, THEME_COLOR_ROLES, updateThemeColorFamily, type ThemeAppearance,
  type ThemeColorRole, type ThemeColors,
} from "./themePalette";
import { asDefinition, themePalette, type CustomTheme } from "./customThemes";

/** The two roles the simple mode edits; every other role is derived from them. */
export const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

export interface ColorFamily { id: string; label: string; role: ThemeColorRole; roles: ReadonlyArray<ThemeColorRole> }
export interface RoleGroup { id: string; title: string; families: ReadonlyArray<ColorFamily> }

export const THEME_EDITOR_ROLE_GROUPS: ReadonlyArray<RoleGroup> = [
  {
    id: "foundation",
    title: "Foundation",
    families: [
      { id: "background", label: "Background", role: "canvas", roles: ["canvas", "chrome", "toolbar"] },
      { id: "surface", label: "Surface", role: "surface", roles: ["surface"] },
      { id: "raised-surface", label: "Raised surface", role: "surfaceRaised", roles: ["surfaceRaised"] },
      { id: "overlay", label: "Overlay", role: "surfaceOverlay", roles: ["surfaceOverlay"] },
      { id: "text", label: "Text", role: "text", roles: ["text", "toolbarForeground", "toolbarControlForeground"] },
      { id: "muted-text", label: "Muted text", role: "mutedForeground", roles: ["textMuted", "mutedForeground", "placeholder", "secondaryLabel", "iconMuted", "sidebarMutedForeground"] },
      { id: "border", label: "Border", role: "border", roles: ["border", "toolbarBorder", "sidebarBorder"] },
      { id: "input", label: "Input", role: "input", roles: ["input"] },
    ],
  },
  {
    id: "brand-content",
    title: "Brand & content",
    families: [
      { id: "subtle-surface", label: "Subtle surface", role: "secondary", roles: ["secondary", "secondaryForeground", "muted", "toolbarControl"] },
      { id: "highlight-surface", label: "Highlight surface", role: "accentSurface", roles: ["accentSurface", "accentSurfaceForeground", "toolbarControlHover"] },
      { id: "accent", label: "Accent", role: "accent", roles: ["accent", "accentForeground", "focus", "update", "updateForeground", "updateSurface", "terminalCursor"] },
      { id: "action", label: "Action", role: "messageAction", roles: ["messageAction", "messageActionForeground", "messageActionHover"] },
      { id: "message-surface", label: "Message surface", role: "messageSurface", roles: ["messageSurface", "messageForeground"] },
      { id: "code-surface", label: "Code surface", role: "codeBackground", roles: ["codeBackground", "codeForeground"] },
    ],
  },
  {
    id: "search",
    title: "Search",
    families: [
      { id: "search-matches", label: "Search matches", role: "searchMatchBackground", roles: ["searchMatchBackground", "searchMatchForeground"] },
      { id: "current-match", label: "Current match", role: "searchMatchActiveBackground", roles: ["searchMatchActiveBackground", "searchMatchActiveForeground"] },
    ],
  },
  {
    id: "context",
    title: "Context",
    families: [
      { id: "sidebar-background", label: "Sidebar background", role: "sidebar", roles: ["sidebar", "sidebarForeground"] },
      { id: "sidebar-controls", label: "Sidebar controls", role: "sidebarControlSurface", roles: ["sidebarControlSurface"] },
      { id: "sidebar-selection", label: "Sidebar selection", role: "sidebarRowSelected", roles: ["sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"] },
      { id: "terminal-background", label: "Terminal background", role: "terminalBackground", roles: ["terminalBackground", "terminalForeground", "terminalSelection", "terminalScrollbar", "terminalScrollbarHover"] },
    ],
  },
  {
    id: "status",
    title: "Status",
    families: [
      { id: "error", label: "Error", role: "error", roles: ["error", "errorForeground", "errorSurface"] },
      { id: "warning", label: "Warning", role: "warning", roles: ["warning", "warningForeground", "warningSurface"] },
    ],
  },
];

export const THEME_EDITOR_COLOR_FAMILIES = THEME_EDITOR_ROLE_GROUPS.flatMap((group) => group.families);
const FAMILY_BY_ROLE = new Map(THEME_EDITOR_COLOR_FAMILIES.flatMap((family) => family.roles.map((role) => [role, family] as const)));
export const getThemeEditorColorFamily = (role: ThemeColorRole): ColorFamily | null => FAMILY_BY_ROLE.get(role) ?? null;

/** getThemeRoleLabel: a role's name as the editor words it. */
export function getThemeRoleLabel(role: ThemeColorRole): string {
  const labels: Partial<Record<ThemeColorRole, string>> = {
    canvas: "Background", toolbar: "Toolbar background", toolbarForeground: "Toolbar text", toolbarBorder: "Toolbar border", toolbarControl: "Toolbar control",
    toolbarControlForeground: "Toolbar control text", toolbarControlHover: "Toolbar control hover", accent: "Accent color", errorForeground: "Error text",
    errorSurface: "Error background", warningForeground: "Warning text", warningSurface: "Warning background", updateForeground: "Update text", updateSurface: "Update background",
  };
  return labels[role] ?? role.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

export type EditorColors = ThemeColors;
export type EditorColorsByAppearance = Record<ThemeAppearance, EditorColors>;

export function getThemeEditorColorsByAppearance(): EditorColorsByAppearance {
  return { light: getStandardThemeColors("light"), dark: getStandardThemeColors("dark") };
}

/** The whole palette the simple mode derives from a background and an accent (a colour that is not valid yet falls back to the standard one). */
export function getManagedEditorColors(appearance: ThemeAppearance, colors: EditorColors): EditorColors {
  const defaults = getStandardThemeColors(appearance);
  return createVividThemeColors(appearance, isThemeColor(colors.canvas.trim()) ? colors.canvas : defaults.canvas, isThemeColor(colors.accent.trim()) ? colors.accent : defaults.accent);
}

export interface EditorSession {
  /** The saved theme being edited, null when making a new one. */
  editingThemeId: string | null;
  /** The theme a new one starts from (a copy), null to start from the standard palette. */
  seedTheme: CustomTheme | null;
  seedName: string | null;
  initialAppearance: ThemeAppearance;
}

export interface EditorDraft {
  name: string;
  activeAppearance: ThemeAppearance;
  isAdvanced: boolean;
  colorsByAppearance: EditorColorsByAppearance;
  simpleColorsDirty: Record<ThemeAppearance, boolean>;
  shouldRegenerateGuidedColors: boolean;
}

/** The draft a session opens with: the colours of the theme being edited or copied, in advanced mode for one whose colours were not derived from two. */
export function initialEditorDraft(session: EditorSession, editing: CustomTheme | null): EditorDraft {
  const source = editing ?? session.seedTheme;
  const colors = getThemeEditorColorsByAppearance();
  let activeAppearance = session.initialAppearance;
  if (source) {
    const definition = asDefinition(source);
    activeAppearance = getThemeModes(definition).includes(session.initialAppearance) ? session.initialAppearance : source.appearance;
    for (const mode of ["light", "dark"] as const) {
      const palette = themePalette(source, mode);
      if (palette) colors[mode] = { ...palette };
    }
  }
  return {
    name: editing?.label ?? session.seedName ?? "",
    activeAppearance,
    // Open unmanaged themes in advanced mode to preserve imported or hand-tuned colors.
    isAdvanced: source !== null && source.managed !== true,
    colorsByAppearance: colors,
    simpleColorsDirty: { light: false, dark: false },
    shouldRegenerateGuidedColors: source !== null && source.managed !== true,
  };
}

/** One colour edited: advanced mode rewrites the roles that follow it, simple mode re-derives the palette from the two colours. */
export function applyColorEdit(draft: EditorDraft, role: ThemeColorRole, value: string): EditorDraft {
  const appearance = draft.activeAppearance;
  const current = draft.colorsByAppearance[appearance];
  const simpleRole = !draft.isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeColor(value.trim());
  const next: EditorColors = { ...current, [role]: value };
  const colors = draft.isAdvanced ? updateFamily(appearance, current, role, value) : simpleRole ? getManagedEditorColors(appearance, next) : next;
  return {
    ...draft,
    colorsByAppearance: { ...draft.colorsByAppearance, [appearance]: colors },
    simpleColorsDirty: simpleRole ? { ...draft.simpleColorsDirty, [appearance]: true } : draft.simpleColorsDirty,
    shouldRegenerateGuidedColors: draft.isAdvanced ? true : draft.shouldRegenerateGuidedColors,
  };
}

const updateFamily = (appearance: ThemeAppearance, colors: EditorColors, role: ThemeColorRole, value: string) => updateThemeColorFamily(appearance, colors, role, value.trim());

/** Turning advanced mode off re-derives the palette from its two colours when advanced edits changed it. */
export function setAdvanced(draft: EditorDraft, checked: boolean, editing: CustomTheme | null): EditorDraft {
  if (checked) return { ...draft, isAdvanced: true };
  const next: EditorDraft = { ...draft, isAdvanced: false };
  if (!draft.shouldRegenerateGuidedColors) return next;
  const managed: ThemeAppearance[] = editing && getThemeModes(asDefinition(editing)).length > 1 ? ["light", "dark"] : [draft.activeAppearance];
  const colors = { ...draft.colorsByAppearance };
  const dirty = { ...draft.simpleColorsDirty };
  for (const appearance of managed) {
    dirty[appearance] = true;
    colors[appearance] = getManagedEditorColors(appearance, colors[appearance]);
  }
  return { ...next, colorsByAppearance: colors, simpleColorsDirty: dirty, shouldRegenerateGuidedColors: false };
}

/** The theme of the same name (or id) the draft would merge into: it is another saved theme, and it takes the draft's palette as its missing appearance. */
export function mergeTargetFor(name: string, editing: CustomTheme | null, library: ReadonlyArray<CustomTheme>): CustomTheme | null {
  const normalized = name.trim().toLowerCase();
  if (normalized === "") return null;
  const targetId = themeIdFromName(name);
  return library.find((theme) => theme.id !== editing?.id && (theme.id === targetId || theme.label.trim().toLowerCase() === normalized)) ?? null;
}

/** Why an appearance cannot be chosen, null when it can (the tooltip on a locked Light or Dark toggle). */
export function appearanceLockReason(appearance: ThemeAppearance, editing: CustomTheme | null, mergeTarget: CustomTheme | null): string | null {
  const editable = editing ? getThemeModes(asDefinition(editing)) : null;
  if (editable && !editable.includes(appearance)) return `“${editing!.label}” has no ${appearance} palette. Create a theme with the same name to add one.`;
  const taken = mergeTarget ? getThemeModes(asDefinition(mergeTarget)) : [];
  if (!editing && taken.includes(appearance)) return `“${mergeTarget!.label}” already has a ${appearance} palette.`;
  return null;
}

export interface SavePlan {
  /** The theme as it is saved. */
  saved: CustomTheme;
  /** A new theme to install; otherwise `saved` replaces the installed one of its id. */
  install: boolean;
  /** The edited theme that is removed because it was merged into another. */
  retire: CustomTheme | null;
  /** The theme the draft merged into, before the merge (kept to undo it). */
  mergeTarget: CustomTheme | null;
  created: boolean;
  mergedAppearance: ThemeAppearance | null;
}

const asCustom = (theme: ReturnType<typeof parseThemeFile>): CustomTheme => theme;

/** handleSubmit of ThemeEditorPanel: what saving the draft does, or the message that says why it cannot. */
export function planThemeSave(draft: EditorDraft, editing: CustomTheme | null, library: ReadonlyArray<CustomTheme>): { plan: SavePlan } | { error: string } {
  const { name, activeAppearance, isAdvanced } = draft;
  if (!name.trim()) return { error: "Name your theme first." };
  try {
    const colorsForSave: EditorColorsByAppearance = !isAdvanced
      ? {
          light: draft.simpleColorsDirty.light ? getManagedEditorColors("light", draft.colorsByAppearance.light) : draft.colorsByAppearance.light,
          dark: draft.simpleColorsDirty.dark ? getManagedEditorColors("dark", draft.colorsByAppearance.dark) : draft.colorsByAppearance.dark,
        }
      : draft.colorsByAppearance;
    const mergeTarget = mergeTargetFor(name, editing, library);
    const taken = mergeTarget ? getThemeModes(asDefinition(mergeTarget)) : [];
    const withCollection = (theme: CustomTheme, from: CustomTheme | null): CustomTheme => (from?.collection ? { ...theme, collection: from.collection } : theme);
    if (editing && mergeTarget) {
      const editedModes = getThemeModes(asDefinition(editing));
      const collision = editedModes.find((mode) => taken.includes(mode));
      if (collision) return { error: `“${mergeTarget.label}” already has a ${collision} palette. Pick another name.` };
      const saved = withCollection(
        asCustom(parseThemeFile({
          version: THEME_FILE_VERSION, id: mergeTarget.id, name: mergeTarget.label, appearance: mergeTarget.appearance, colors: mergeTarget.colors,
          variants: { ...mergeTarget.variants, ...Object.fromEntries(editedModes.map((mode) => [mode, colorsForSave[mode]])) },
          ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
        })),
        mergeTarget,
      );
      return { plan: { saved, install: false, retire: editing, mergeTarget, created: false, mergedAppearance: editedModes[0] ?? null } };
    }
    if (editing) {
      const base = editing.appearance;
      const variantAppearance: ThemeAppearance = base === "light" ? "dark" : "light";
      const saved = withCollection(
        asCustom(parseThemeFile({
          version: THEME_FILE_VERSION, id: editing.id, name, appearance: base, colors: colorsForSave[base],
          ...(getThemeModes(asDefinition(editing)).length > 1 ? { variants: { [variantAppearance]: colorsForSave[variantAppearance] } } : {}),
          ...(isAdvanced ? {} : { managed: true }),
        })),
        editing,
      );
      return { plan: { saved, install: false, retire: null, mergeTarget: null, created: false, mergedAppearance: null } };
    }
    if (mergeTarget) {
      if (taken.includes(activeAppearance)) return { error: `“${mergeTarget.label}” already has light and dark palettes. Pick another name.` };
      const saved = withCollection(
        asCustom(parseThemeFile({
          version: THEME_FILE_VERSION, id: mergeTarget.id, name: mergeTarget.label, appearance: mergeTarget.appearance, colors: mergeTarget.colors,
          variants: { ...mergeTarget.variants, [activeAppearance]: colorsForSave[activeAppearance] },
          ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
        })),
        mergeTarget,
      );
      return { plan: { saved, install: false, retire: null, mergeTarget, created: false, mergedAppearance: activeAppearance } };
    }
    const saved = asCustom(parseThemeFile({
      version: THEME_FILE_VERSION, name, appearance: activeAppearance, colors: colorsForSave[activeAppearance], ...(isAdvanced ? {} : { managed: true }),
    }));
    return { plan: { saved, install: true, retire: null, mergeTarget: null, created: true, mergedAppearance: null } };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : editing ? "Could not save the theme." : "Could not create the theme." };
  }
}

export const ROLES_COUNT = THEME_COLOR_ROLES.length;
