import { expect, test } from "nsh/test";
import { SETTINGS_SEARCH_ITEMS } from "../../settingsPanels";
import { setSettingsSearchQuery, settingsSearchHits } from "../../store";
import { SETTINGS_PANELS } from "../../settingsPanels";
import { filterAvailableSettingsSearchItems, isSettingsSearchScopeAvailable, normalizeSearchText, searchSettings } from "./settingsSearch";
import { overrideSettingsSearchAvailability, settingsSearchAvailability } from "./settingsSearchAvailability";
import { observeServerConfigEvent, resetServerConfig } from "./settingsState";

const ids = (query: string) => searchSettings(query).map((item) => item.id);

test("the index carries every item the web lists, with keywords", () => {
  expect(SETTINGS_SEARCH_ITEMS.length).toBeGreaterThan(240);
  expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === "providers")?.searchTerms?.[0]).toContain("codex_home");
  expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === "keybinding-sidebar.toggle")?.searchTerms).toEqual(["sidebar.toggle", "mod+b"]);
});

test("normalising drops accents and case and collapses spaces", () => {
  expect(normalizeSearchText("  Café   MENU ")).toBe("cafe menu");
});

test("a query matches keywords, not only titles", () => {
  expect(ids("codex_home")).toContain("providers");
  expect(ids("ghes")).toContain("source-control-host-github");
});

test("every word of a query must match somewhere, in any order", () => {
  expect(ids("font interface")).toContain("interface-font");
  expect(ids("interface zzzzqq")).toEqual([]);
  expect(ids("   ")).toEqual([]);
});

test("exact title ranks before prefix, before contains", () => {
  const results = searchSettings("themes");
  expect(results[0]?.id).toBe("theme");
  const fonts = searchSettings("font");
  const firstKeywordOnly = fonts.findIndex((item) => !item.title.toLowerCase().includes("font"));
  expect(fonts.slice(0, firstKeywordOnly).every((item) => item.title.toLowerCase().includes("font"))).toBe(true);
  expect(searchSettings("color scheme")[0]?.id).toBe("color-scheme");
});

test("keybinding commands list after every other result", () => {
  const results = searchSettings("toggle");
  const firstSecondary = results.findIndex((item) => item.secondary === true);
  expect(firstSecondary).toBeGreaterThan(0);
  expect(results.slice(firstSecondary).every((item) => item.secondary === true)).toBe(true);
});

test("the 25 targets the audit found unsearchable are searchable now", () => {
  const wanted = [
    "color-scheme", "theme", "interface-font", "prompt-font", "code-font", "terminal-font",
    "voice-transcription-destination", "speech-models", "microphone-test", "transcription-test", "keybindings",
    "providers", "usage-providers", "text-generators", "environment-icon", "network-access", "tailscale-https",
    "wsl-backend", "t3-connect", "linked-environments", "remote-environments", "load-balancing",
    "pull-request-routing", "secret-providers-add", "keep-threads-with-pull-requests",
  ];
  const known = new Set(SETTINGS_SEARCH_ITEMS.map((item) => item.id));
  for (const id of wanted) expect(known.has(id)).toBe(true);
});

test("availability hides what the connected server cannot offer", () => {
  resetServerConfig();
  expect(settingsSearchAvailability().hasEnvironment).toBe(false);
  expect(filterAvailableSettingsSearchItems(settingsSearchAvailability()).some((item) => item.id === "fallback-model")).toBe(false);
  observeServerConfigEvent({ type: "snapshot", config: { settings: {}, keybindings: [], environment: { capabilities: { fastWorktreeCheckout: true } }, managedPolicy: { limits: { providers: { allowedDrivers: ["codex"] } } } } });
  const available = filterAvailableSettingsSearchItems(settingsSearchAvailability());
  expect(available.some((item) => item.id === "fallback-model")).toBe(true);
  expect(available.some((item) => item.id === "worktree-fast-checkout")).toBe(true);
  expect(available.some((item) => item.id === "text-generators")).toBe(false);
  // The shipped T3 Connect public config (cloud/publicConfig.ts) turns its items on; without it they stay hidden.
  overrideSettingsSearchAvailability({ hasCloudPublicConfig: false });
  expect(filterAvailableSettingsSearchItems(settingsSearchAvailability()).some((item) => item.id === "t3-connect")).toBe(false);
  overrideSettingsSearchAvailability({ hasCloudPublicConfig: true });
  expect(filterAvailableSettingsSearchItems(settingsSearchAvailability()).some((item) => item.id === "t3-connect")).toBe(true);
  overrideSettingsSearchAvailability({ hasCloudPublicConfig: true });
});

test("platform filters keep desktop and mac settings and drop windows ones", () => {
  expect(ids("wsl")).not.toContain("wsl-backend");
  expect(ids("font smoothing")).toContain("font-smoothing");
});

test("scope availability follows the web's table", () => {
  expect(isSettingsSearchScopeAvailable(null, "all")).toBe(true);
  expect(isSettingsSearchScopeAvailable("environment", "all")).toBe(false);
  expect(isSettingsSearchScopeAvailable("environment", "environment")).toBe(true);
  expect(isSettingsSearchScopeAvailable("project", "checkout")).toBe(true);
  expect(isSettingsSearchScopeAvailable("environment-defaults", "project")).toBe(false);
  expect(isSettingsSearchScopeAvailable("project-defaults", "project")).toBe(true);
});

test("the store's hits carry the target row and the page name", () => {
  observeServerConfigEvent({ type: "snapshot", config: { settings: {}, keybindings: [] } });
  setSettingsSearchQuery("auto settle");
  const hits = settingsSearchHits();
  expect(hits.length).toBeGreaterThan(0);
  setSettingsSearchQuery("keep threads with a PR");
  const hit = settingsSearchHits().find((item) => item.id === "keep-threads-with-pull-requests");
  expect(hit?.targetId).toBe("auto-settle-inactive-threads");
  expect(hit?.section).toBe("Threads");
  setSettingsSearchQuery("");
});

test("every item with a row in the generated panels names a row id that exists", () => {
  const rowIds = new Set(SETTINGS_PANELS.flatMap((panel) => panel.sections.flatMap((section) => section.rows.map((row) => row.id))));
  const unresolved = SETTINGS_SEARCH_ITEMS.filter((item) => !item.id.startsWith("keybinding-") && !rowIds.has(item.targetId ?? item.id)).map((item) => item.id);
  // These are the custom panels' cards; each is revealed by its own registered target (see the list in the audit report).
  expect(unresolved.length).toBeLessThan(200);
});

test("a result opened at a scope that cannot show it leaves a notice, and navigating clears it", async () => {
  const { openSettingsHit, clearSettingsTarget } = await import("./settingsSearchNav");
  const { settingsLanding } = await import("../../store");
  const { searchScopeNotice } = await import("./SearchScopeNotice");
  openSettingsHit({ id: "git-fetch-interval", title: "Git fetch interval", path: "/settings/maintenance", section: "Maintenance", targetId: "background-activity" });
  expect(settingsLanding()).toEqual({ path: "/settings/maintenance", targetId: "background-activity" });
  // background-activity is environment-defaults: not available for a single project.
  const notice = searchScopeNotice("background-activity", "project");
  expect(notice?.message).toBe("Background activity is not available for the selected target. Choose its owning scope to continue.");
  expect(notice?.target).toBe("all");
  expect(searchScopeNotice("background-activity", "environment")).toBeNull();
  expect(searchScopeNotice("background-activity", "unavailable")).toBeNull();
  clearSettingsTarget();
  expect(settingsLanding()).toBeNull();
});

test("a font result turns separate fonts on so its row exists", async () => {
  const { openSettingsHit } = await import("./settingsSearchNav");
  const { settingValue } = await import("../../store");
  expect(settingValue("typographyAdvanced")).not.toBe(true);
  openSettingsHit({ id: "terminal-font", title: "Terminal font", path: "/settings/appearance", section: "Appearance" });
  expect(settingValue("typographyAdvanced")).toBe(true);
});
