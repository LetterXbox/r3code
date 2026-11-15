// readManagedPolicy("darwin") against packages/shared managedPolicyFile.ts.
import { expect, test } from "nsh/test";
import { MACOS_MANAGED_POLICY_FILE, MACOS_MANAGED_PREFERENCES_PATH, readMacManagedPolicy, unwrapForced, type PolicyReadDeps } from "./managedPolicy";

function deps(files: Record<string, string>, plist?: { code: number; stdout: string }): PolicyReadDeps & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    exists: async (path) => path in files || (path === MACOS_MANAGED_PREFERENCES_PATH && plist !== undefined),
    readText: async (path) => files[path]!,
    run: async (command, args) => { ran.push([command, ...args].join(" ")); return plist ?? { code: 1, stdout: "" }; },
  };
}

test("no profile and no file: no policy", async () => {
  expect(await readMacManagedPolicy(deps({}))).toBe(undefined);
});

test("a profile is converted by plutil; MCX Forced wrappers and Payload keys are dropped", async () => {
  const d = deps({}, { code: 0, stdout: JSON.stringify({ PayloadUUID: "x", Forced: [{ mcx_preference_settings: { organization: "Acme", limits: { connect: false }, _meta: 1 } }] }) });
  expect(await readMacManagedPolicy(d)).toEqual({ source: MACOS_MANAGED_PREFERENCES_PATH, document: { organization: "Acme", limits: { connect: false } } });
  expect(d.ran).toEqual([`/usr/bin/plutil -convert json -o - ${MACOS_MANAGED_PREFERENCES_PATH}`]);
  expect(unwrapForced(JSON.stringify({ organization: "Direct" }))).toEqual({ organization: "Direct" });
});

test("the policy file alone is used; both sources, an unreadable profile or an unknown key are refused", async () => {
  expect(await readMacManagedPolicy(deps({ [MACOS_MANAGED_POLICY_FILE]: '{"organization":"Acme"}' }))).toEqual({ source: MACOS_MANAGED_POLICY_FILE, document: { organization: "Acme" } });
  const message = async (d: PolicyReadDeps) => { try { await readMacManagedPolicy(d); return ""; } catch (error) { return (error as Error).message; } };
  expect(await message(deps({ [MACOS_MANAGED_POLICY_FILE]: '{"organization":"A"}' }, { code: 0, stdout: '{"organization":"B"}' })))
    .toBe(`T3 Code cannot use the managed policy at ${MACOS_MANAGED_PREFERENCES_PATH}: a policy file at ${MACOS_MANAGED_POLICY_FILE} also exists; deploy the policy one way. It will not start until an administrator fixes this.`);
  expect(await message(deps({}, { code: 1, stdout: "" }))).toContain("the profile cannot be read");
  expect(await message(deps({ [MACOS_MANAGED_POLICY_FILE]: '{"organization":"A","future":1}' }))).toContain('Expected no excess property at ["future"]');
});
