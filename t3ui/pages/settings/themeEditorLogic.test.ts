// The editor's rules (ThemeEditorPanel.tsx) and the library's grouping (ThemeSettings.tsx), plus the palette derivation they rest on.
import { expect, test } from "nsh/test";
import { parseThemeFile } from "./themeFile";
import {
  appearanceLockReason, applyColorEdit, getThemeRoleLabel, initialEditorDraft, mergeTargetFor, planThemeSave, setAdvanced, THEME_EDITOR_COLOR_FAMILIES, THEME_EDITOR_ROLE_GROUPS,
} from "./themeEditorLogic";
import { collectionVariantLabels, groupCustomThemes } from "./themeLibraryLogic";
import { createVividThemeColors, themeColorToHex, THEME_COLOR_ROLES } from "./themePalette";
import type { CustomTheme } from "./customThemes";

const session = { editingThemeId: null, seedTheme: null, seedName: null, initialAppearance: "dark" as const };
const theme = (name: string, appearance: "light" | "dark", extra: object = {}): CustomTheme =>
  parseThemeFile({ version: 1, name, appearance, colors: { canvas: appearance === "dark" ? "#101020" : "#fafafa", accent: "#ff8800" }, ...extra });

test("every role belongs to exactly the families the editor groups", () => {
  const grouped = THEME_EDITOR_COLOR_FAMILIES.flatMap((family) => family.roles);
  expect(new Set(grouped).size).toBe(grouped.length);
  expect([...grouped].sort()).toEqual([...THEME_COLOR_ROLES].sort());
  expect(THEME_EDITOR_ROLE_GROUPS.map((group) => group.title)).toEqual(["Foundation", "Brand & content", "Search", "Context", "Status"]);
  expect(getThemeRoleLabel("canvas")).toBe("Background");
  expect(getThemeRoleLabel("sidebarRowHover")).toBe("Sidebar Row Hover");
});

test("two colors derive a whole readable palette", () => {
  const colors = createVividThemeColors("dark", "#101020", "#ff8800");
  expect(Object.keys(colors)).toHaveLength(THEME_COLOR_ROLES.length);
  expect(themeColorToHex(colors.canvas)).toBe("#101020");
  expect(themeColorToHex(colors.accent)).toBe("#ff8800");
});

test("simple mode re-derives from the two colors and advanced mode rewrites the family", () => {
  let draft = initialEditorDraft(session, null);
  expect(draft.isAdvanced).toBe(false);
  draft = applyColorEdit(draft, "accent", "#00aa55");
  expect(draft.simpleColorsDirty.dark).toBe(true);
  expect(themeColorToHex(draft.colorsByAppearance.dark.focus)).toBe("#00aa55");
  const advanced = setAdvanced(draft, true, null);
  const edited = applyColorEdit(advanced, "canvas", "#202040");
  expect(edited.colorsByAppearance.dark.chrome).toBe("#202040");
  expect(edited.colorsByAppearance.dark.toolbar).toBe("#202040");
  expect(edited.shouldRegenerateGuidedColors).toBe(true);
});

test("saving makes a new theme, edits one, or merges a palette into the theme of the same name", () => {
  const draft = { ...initialEditorDraft(session, null), name: "Aurora" };
  const created = planThemeSave(draft, null, []);
  if (!("plan" in created)) throw new Error("expected a plan");
  expect(created.plan).toMatchObject({ install: true, created: true, mergedAppearance: null });
  expect(created.plan.saved).toMatchObject({ id: "aurora", label: "Aurora", appearance: "dark", managed: true });
  expect(planThemeSave({ ...draft, name: " " }, null, [])).toEqual({ error: "Name your theme first." });

  const aurora = created.plan.saved;
  expect(mergeTargetFor("aurora", null, [aurora])?.id).toBe("aurora");
  const light = { ...initialEditorDraft({ ...session, initialAppearance: "light" }, null), name: "Aurora" };
  const merged = planThemeSave(light, null, [aurora]);
  if (!("plan" in merged)) throw new Error("expected a merge plan");
  expect(merged.plan.mergedAppearance).toBe("light");
  expect(Object.keys(merged.plan.saved.variants ?? {})).toEqual(["light"]);
  // A name that already has both palettes, or the same appearance, is refused with the web's words.
  expect(planThemeSave({ ...draft, name: "Aurora" }, null, [aurora])).toEqual({ error: "“Aurora” already has light and dark palettes. Pick another name." });
  expect(appearanceLockReason("dark", null, aurora)).toBe("“Aurora” already has a dark palette.");
  expect(appearanceLockReason("light", aurora, null)).toBe("“Aurora” has no light palette. Create a theme with the same name to add one.");

  const edit = planThemeSave({ ...initialEditorDraft({ ...session, editingThemeId: "aurora" }, aurora), name: "Aurora Night" }, aurora, [aurora]);
  if (!("plan" in edit)) throw new Error("expected an edit plan");
  expect(edit.plan).toMatchObject({ install: false, created: false });
  expect(edit.plan.saved.id).toBe("aurora");
  expect(edit.plan.saved.label).toBe("Aurora Night");
});

test("the library groups a collection's themes on one card and names variants by what they do not share", () => {
  const a = theme("Dracula", "dark", { collection: { id: "open-vsx:d.d", label: "Dracula" } });
  const b = theme("Dracula Soft", "dark", { collection: { id: "open-vsx:d.d", label: "Dracula" } });
  const c = theme("Solo", "dark");
  const groups = groupCustomThemes([a, c, b]);
  expect(groups.map(([key, items]) => [key, items.map((item) => item.label)])).toEqual([["collection:open-vsx:d.d", ["Dracula", "Dracula Soft"]], ["theme:solo", ["Solo"]]]);
  expect(collectionVariantLabels([{ label: "Github Dark" }, { label: "Github Light" }])).toEqual(["Dark", "Light"]);
  expect(collectionVariantLabels([{ label: "Dracula" }, { label: "Dracula Soft" }])).toEqual(["Dracula", "Dracula Soft"]);
});
