import { expect, test } from "nsh/test";
import { filterSharedServerPatch, splitSharedServerPatch } from "./sharedSettings";

test("only shared settings sync, filtered per target environment", () => {
  expect(splitSharedServerPatch({ snoozePresets: [1], enableAssistantStreaming: true })).toEqual({ sharedPatch: { snoozePresets: [1] }, localPatch: { enableAssistantStreaming: true } });
  const source = { providerInstances: { codex: { driver: "codex" } } };
  const selection = { textGenerationModelSelection: { instanceId: "codex", model: "m" } };
  // A target without that provider instance's driver keeps its own text generation model.
  expect(filterSharedServerPatch(selection, { providerInstances: { codex: { driver: "claude" } } }, source)).toEqual({});
  expect(filterSharedServerPatch(selection, { providerInstances: { codex: { driver: "codex" } } }, source)).toEqual(selection);
  expect(filterSharedServerPatch(selection, { providerInstances: { codex: { driver: "codex", enabled: false } } }, source)).toEqual({});
  // An unknown target config never gets continueThreadsAfterServerUpdate.
  expect(filterSharedServerPatch({ continueThreadsAfterServerUpdate: true, snoozePresets: [] }, null, source)).toEqual({ snoozePresets: [] });
  expect(filterSharedServerPatch(selection, null, source, true)).toEqual(selection);
});
