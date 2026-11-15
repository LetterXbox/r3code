import { expect, test } from "nsh/test";
import { environmentIconWrite, resolveEnvironmentIconPickerLock } from "./EnvironmentIconMenu";
import { ENVIRONMENT_MACHINE_KIND_LABELS, resolveEnvironmentMachineKind } from "./MachineIcon";

test("the machine kind is the user's pick, else the detected one, else server", () => {
  expect(resolveEnvironmentMachineKind(null)).toBe("server");
  expect(resolveEnvironmentMachineKind({ environment: { platform: { machine: "mac-mini" } } })).toBe("mac-mini");
  expect(resolveEnvironmentMachineKind({ environment: { platform: { machine: "mac-mini" } }, settings: { environmentIcon: "laptop" } })).toBe("laptop");
  expect(resolveEnvironmentMachineKind({ environment: { platform: {} }, settings: { environmentIcon: null } })).toBe("server");
  expect(resolveEnvironmentMachineKind({ environment: { platform: { machine: "toaster" } } })).toBe("server");
  expect(ENVIRONMENT_MACHINE_KIND_LABELS["mac-studio"]).toBe("Workstation");
});

test("the icon picker says why it is locked, and the detected kind clears the setting", () => {
  expect(resolveEnvironmentIconPickerLock({ hasConfig: false, operateAccess: "granted" })).toBe("Connect to this environment to change its icon.");
  expect(resolveEnvironmentIconPickerLock({ hasConfig: true, operateAccess: "denied" })).toBe("Your session on this environment cannot change its settings.");
  expect(resolveEnvironmentIconPickerLock({ hasConfig: true, operateAccess: "granted" })).toBeNull();
  expect(environmentIconWrite("mac-mini", "mac-mini")).toBeNull();
  expect(environmentIconWrite("laptop", "mac-mini")).toBe("laptop");
});
