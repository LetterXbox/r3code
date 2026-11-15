import { expect, test } from "nsh/test";
import { resolveEffectiveComposerModel, resolveSelectableDriver } from "./modelFixup";

const records = [
  { instanceId: "codex", driver: "codex", enabled: true, models: [{ slug: "old", isCustom: true }, { slug: "a" }, { slug: "b", isDefault: true }] },
  { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, models: [{ slug: "c" }] },
  { instanceId: "off", driver: "cursor", enabled: false, models: [{ slug: "x" }] },
];
const available = [{ provider: "codex", model: "a" }, { provider: "codex", model: "b" }, { provider: "claudeAgent", model: "c" }];

test("the composer keeps the thread's model, else its instance's default, else the selectable driver's (deriveEffectiveComposerModelState)", () => {
  expect(resolveEffectiveComposerModel({ selection: { provider: "codex", model: "a" }, available, records })).toEqual({ provider: "codex", model: "a" });
  expect(resolveEffectiveComposerModel({ selection: { provider: "codex", model: "gone" }, available, records, retained: { provider: "claudeAgent", model: "c" } })).toEqual({ provider: "codex", model: "b" });
  expect(resolveEffectiveComposerModel({ selection: { provider: "off", model: "x" }, available, records })).toEqual({ provider: "codex", model: "b" });
  expect(resolveEffectiveComposerModel({ selection: null, available, records, retained: { provider: "claudeAgent", model: "c" } })).toEqual({ provider: "claudeAgent", model: "c" });
  expect(resolveEffectiveComposerModel({ selection: null, available: [], records })).toBe(null);
  expect(resolveSelectableDriver(records, "off")).toBe("codex");
  expect(resolveSelectableDriver([], null)).toBe("codex");
  expect(resolveSelectableDriver(records, "claudeAgent")).toBe("claudeAgent");
});
