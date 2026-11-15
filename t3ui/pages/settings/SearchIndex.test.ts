import { expect, test } from "nsh/test";
import { setSettingsSearchQuery, settingsSearchHits } from "../../store";
import { observeServerConfigEvent } from "./settingsState";

// Settings that need an environment (the web hides them without one) are searchable once a server config has arrived.
observeServerConfigEvent({ type: "snapshot", config: { settings: {}, keybindings: [] } });

const hitFor = (query: string) => { setSettingsSearchQuery(query); return settingsSearchHits().map((hit) => `${hit.path}#${hit.id}`); };

test("the rows the pages draw from the scope are searchable and reveal their page", () => {
  expect(hitFor("Fallback model")).toContain("/settings/threads#fallback-model");
  expect(hitFor("Permissions")).toContain("/settings/threads#default-permissions");
  expect(hitFor("Default merge method")).toContain("/settings/source-control#pull-request-merge-method");
  expect(hitFor("Automatically pull")).toContain("/settings/source-control#automatic-pull");
  expect(hitFor("Remove agent credits")).toContain("/settings/source-control#remove-agent-credits-on-merge");
});

test("cards and dialogs the pages draw whole are search targets too", () => {
  expect(hitFor("OpenTelemetry")).toContain("/settings/diagnostics#telemetry-export");
  expect(hitFor("Device sources")).toContain("/settings/devices#device-sources");
  expect(hitFor("Worktree cleanup")).toContain("/settings/worktrees#storage-worktrees");
  expect(hitFor("Git fetch interval")).toContain("/settings/maintenance#git-fetch-interval");
  expect(hitFor("Background activity")).toContain("/settings/maintenance#background-activity");
  setSettingsSearchQuery("");
});
