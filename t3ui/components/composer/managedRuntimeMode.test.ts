import { expect, test } from "nsh/test";
import { managedRuntimeModeItem, runtimeModeOptions } from "./runtimeModeConfig";

const policy = { organization: "Acme", limits: { maxRuntimeMode: "auto-accept-edits" } };
const ALL = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

test("modes above the ceiling stay listed, disabled with the organization's reason", () => {
  expect(runtimeModeOptions(ALL, policy)).toEqual([
    { mode: "approval-required" }, { mode: "auto-accept-edits" },
    { mode: "auto", disabledReason: "Acme limits threads to Auto-accept edits." },
    { mode: "full-access", disabledReason: "Acme limits threads to Auto-accept edits." },
  ]);
  expect(runtimeModeOptions(ALL, null).every((option) => option.disabledReason === undefined)).toBe(true);
});

test("a thread above the ceiling gets the warning with Switch to the broadest mode left", () => {
  const switched: string[] = [];
  const item = managedRuntimeModeItem({ policy, mode: "full-access", modes: ALL, onSwitch: (mode) => switched.push(mode) })!;
  expect([item.id, item.variant, item.icon, item.title]).toEqual(["managed-runtime-mode", "warning", "building", "Acme limits threads to Auto-accept edits."]);
  expect(item.actions.map((action) => action.label)).toEqual(["Switch to Auto-accept edits"]);
  item.actions[0]!.run();
  expect(switched).toEqual(["auto-accept-edits"]);
  expect(managedRuntimeModeItem({ policy, mode: "approval-required", modes: ALL, onSwitch: () => {} })).toBe(null);
});
