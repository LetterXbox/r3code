import { expect, test } from "nsh/test";
import { disallowedProviderMessage, isManagedDriverAllowed, managedInstanceLocks, parseManagedPolicy, showTextGenerators } from "./policyLogic";

const policy = parseManagedPolicy({
  organization: "Acme", supportUrl: "https://acme.test/help", lockedSettings: ["a.b"],
  limits: { providers: { allowedDrivers: ["codex", "claudeAgent"], lockedInstanceFields: { codex: ["config.binaryPath", "environment.OPENAI_API_KEY", "config.setupMode"], cursor: ["environment"], claudeAgent: [] } } },
});

test("an unmanaged environment has no policy and no locks", () => {
  expect(parseManagedPolicy(undefined)).toBeUndefined();
  expect(parseManagedPolicy({ organization: "  " })).toBeUndefined();
  expect(managedInstanceLocks(undefined, "codex")).toBeUndefined();
  expect(isManagedDriverAllowed(undefined, "anything")).toBe(true);
  expect(showTextGenerators(undefined)).toBe(true);
});

test("locked instance fields split into config keys and environment names", () => {
  const locks = managedInstanceLocks(policy, "codex");
  expect([...(locks?.configKeys ?? [])].sort()).toEqual(["binaryPath", "setupMode"]);
  expect([...(locks?.environmentNames ?? [])]).toEqual(["OPENAI_API_KEY"]);
  expect(locks?.wholeEnvironment).toBe(false);
  expect(locks?.reason).toBe("Managed by Acme.");
  expect(managedInstanceLocks(policy, "cursor")?.wholeEnvironment).toBe(true);
  expect(managedInstanceLocks(policy, "claudeAgent")).toBeUndefined();
  expect(managedInstanceLocks(policy, "opencode")).toBeUndefined();
});

test("an allow-list refuses other drivers, names the organization and hides text generators", () => {
  expect(isManagedDriverAllowed(policy, "codex")).toBe(true);
  expect(isManagedDriverAllowed(policy, "cursor")).toBe(false);
  expect(disallowedProviderMessage("Acme", "Cursor")).toBe("Acme's policy does not allow the Cursor provider.");
  expect(disallowedProviderMessage(undefined, "Cursor")).toBe("Your organization policy does not allow the Cursor provider.");
  expect(showTextGenerators(policy)).toBe(false);
  expect(policy?.supportUrl).toBe("https://acme.test/help");
});
