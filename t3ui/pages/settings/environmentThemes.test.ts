// The environment's published themes (themePalette.ts publishedThemeDefinitions) and default theme adoption
// (hooks/useDefaultTheme.ts), fed with contract-shaped config stream events (ServerConfigStreamEvent).
import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { defaultThemeToApply, environmentThemeById, environmentThemes, observeEnvironmentThemesEvent, publishedThemeDefinitions, startDefaultThemeAdoption } from "./environmentThemes";
import { paletteOfThemeId } from "./customThemes";
import { cardById } from "./themeSelection";
import { observeServerConfigEvent, resetServerConfig } from "./settingsState";

const harbor = { id: "harbor", name: "Harbor", appearance: "dark", canvas: "#0b1622", accent: "#3aa0ff" };
const paper = { id: "paper", name: "Paper", appearance: "light", colors: { canvas: "#fbf7ef", text: "#222222", bogusRole: "#ff0000" } };

test("publishedThemeDefinitions: seeded and coloured themes render; reserved ids and empty ones are dropped", () => {
  const out = publishedThemeDefinitions([harbor, paper, { id: "dark", name: "Dark", appearance: "dark", colors: { background: "#000000" } }, { id: "empty", name: "Empty", appearance: "light", colors: { nope: "#fff" } }]);
  expect(out.map((theme) => theme.id)).toEqual(["harbor", "paper"]);
  expect(out[0]!.managed).toBe(true);
  expect(out[0]!.label).toBe("Harbor");
  expect(out[1]!.colors.canvas).toBe("#fbf7ef");
  expect(out[1]!.colors.bogusRole).toBeUndefined();
  expect(out[1]!.managed).toBeUndefined();
});

test("the config snapshot and environmentThemesUpdated publish the palettes; ids resolve after built-in and saved ones", () => {
  resetServerConfig();
  observeServerConfigEvent({ version: 1, type: "snapshot", config: { settings: {}, environmentThemes: [harbor] } });
  expect(environmentThemes().map((theme) => theme.id)).toEqual(["harbor"]);
  expect(paletteOfThemeId("harbor", "dark")?.appearance).toBe("dark");
  expect(cardById("harbor").label).toBe("Harbor");
  const before = environmentThemes();
  // A reconnect snapshot with the same set keeps the same array (nothing repaints).
  observeEnvironmentThemesEvent({ version: 1, type: "snapshot", config: { environmentThemes: [harbor] } });
  expect(environmentThemes()).toBe(before);
  observeServerConfigEvent({ version: 1, type: "environmentThemesUpdated", payload: { themes: [harbor, paper] } });
  expect(environmentThemeById("paper")?.appearance).toBe("light");
  const withPaper = environmentThemes();
  observeEnvironmentThemesEvent({ type: "environmentThemesUpdated", payload: { themes: [{ ...harbor, background: "png-r2" }, paper] } });
  expect(environmentThemeById("harbor")?.background).toBe("png-r2");
  expect(environmentThemes()).not.toBe(withPaper);
  resetServerConfig();
  expect(environmentThemes()).toEqual([]);
});

test("defaultThemeToApply: once per generation, only when the id resolves", () => {
  const base = { environmentId: "env-1", defaultTheme: "harbor", defaultThemeSetAt: "2026-11-13T10:00:00Z", appliedGeneration: null, resolves: true };
  expect(defaultThemeToApply(base)).toBe("harbor@2026-11-13T10:00:00Z");
  expect(defaultThemeToApply({ ...base, appliedGeneration: "harbor@2026-11-13T10:00:00Z" })).toBeNull();
  expect(defaultThemeToApply({ ...base, resolves: false })).toBeNull();
  expect(defaultThemeToApply({ ...base, environmentId: null })).toBeNull();
  expect(defaultThemeToApply({ ...base, defaultThemeSetAt: "" })).toBe("harbor");
});

test("startDefaultThemeAdoption applies a late-resolving default once, and again when it is reasserted", async () => {
  const settings = signal<Record<string, unknown> | null>({ defaultTheme: "harbor", defaultThemeSetAt: "t1" });
  const known = signal(false);
  const applied: string[] = [];
  const store = new Map<string, string>();
  startDefaultThemeAdoption({
    environmentId: () => "env-1",
    settings: () => settings(),
    modesOf: (id) => (known() && id === "harbor" ? ["dark"] : null),
    apply: (id, modes) => applied.push(`${id}:${modes.join("+")}`),
    setAppearance: (mode) => applied.push(`appearance:${mode}`),
    read: async (key) => store.get(key) ?? null,
    write: async (key, value) => { store.set(key, value); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(applied).toEqual([]);
  known.set(true);
  // modesOf is read untracked: the published set changing is what re-checks it.
  observeEnvironmentThemesEvent({ version: 1, type: "environmentThemesUpdated", payload: { themes: [harbor] } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(environmentThemes().map((theme) => theme.id)).toEqual(["harbor"]);
  expect(applied).toEqual(["harbor:dark", "appearance:dark"]);
  expect(store.get("t3code:default-theme-applied:v2:env-1")).toBe("harbor@t1");
  settings.set({ defaultTheme: "harbor", defaultThemeSetAt: "t1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(applied.length).toBe(2);
  settings.set({ defaultTheme: "harbor", defaultThemeSetAt: "t2" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(applied.length).toBe(4);
  resetServerConfig();
});
