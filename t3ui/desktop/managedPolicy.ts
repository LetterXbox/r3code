// app/DesktopManagedPolicy.ts + packages/shared managedPolicyFile.ts readManagedPolicy("darwin"): the administrator's policy as the
// desktop app reads it, once: a configuration profile's managed preferences (/Library/Managed Preferences/com.t3tools.t3code.plist,
// converted by /usr/bin/plutil, keys directly or under Forced[0].mcx_preference_settings, profile keys dropped) or the policy file
// (/Library/Application Support/T3Code/policy.json). Both present is refused, never merged.
//
// The port keeps the reference's shape check light (an object with an organization, the keys the policy schema knows at the top
// level); the server, which reads the same sources with the full schema, stays the authority for what it enforces. A policy that
// cannot be used stops the reference at startup (DesktopStartupRecovery's ManagedPolicy page); installManagedPolicyCheck does the
// same here, presenting the startup recovery screen instead of letting the app proceed with a policy it cannot use.
import { readFile as readTextFile } from "fs/promises";
import { desktop, isMac } from "./runtime";
import { presentStartupRecovery } from "./startupRecovery";

export const MACOS_MANAGED_PREFERENCES_PATH = "/Library/Managed Preferences/com.t3tools.t3code.plist";
export const MACOS_MANAGED_POLICY_FILE = "/Library/Application Support/T3Code/policy.json";
const PLUTIL = "/usr/bin/plutil";
/** ManagedPolicyDocument's top-level keys. */
const DOCUMENT_KEYS = new Set(["organization", "supportUrl", "settings", "limits"]);

export interface ManagedPolicyRead { source: string; document: Record<string, unknown> }

export class ManagedPolicyFileError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`T3 Code cannot use the managed policy at ${path}: ${reason}. It will not start until an administrator fixes this.`);
  }
}

export interface PolicyReadDeps {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string>;
  run: (command: string, args: string[]) => Promise<{ code?: number | null; stdout: string }>;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const withoutProfileKeys = (value: unknown) =>
  isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("Payload") && !key.startsWith("_"))) : value;

/** unwrapForced: a profile's keys directly, or MCX-style under Forced[0].mcx_preference_settings. */
export function unwrapForced(json: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return json; }
  const preferences = withoutProfileKeys(parsed);
  if (isObject(preferences) && Object.keys(preferences).length === 1 && Array.isArray(preferences.Forced) && preferences.Forced.length === 1) {
    const forced = preferences.Forced[0];
    if (isObject(forced) && Object.keys(forced).length === 1 && "mcx_preference_settings" in forced) return withoutProfileKeys(forced.mcx_preference_settings);
  }
  return preferences;
}

/** decodeDocument, lightly: JSON text or a parsed value; unknown top-level keys are refused, as the schema's excess-property check. */
export function decodePolicyDocument(path: string, raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { throw new ManagedPolicyFileError(path, "it is not valid JSON or does not match the policy schema"); }
  }
  if (!isObject(value) || typeof value.organization !== "string") throw new ManagedPolicyFileError(path, "it is not valid JSON or does not match the policy schema");
  const excess = Object.keys(value).find((key) => !DOCUMENT_KEYS.has(key));
  if (excess !== undefined) throw new ManagedPolicyFileError(path, `it is not valid JSON or does not match the policy schema (Expected no excess property at ["${excess}"])`);
  return value;
}

async function readProfile(deps: PolicyReadDeps): Promise<ManagedPolicyRead | undefined> {
  const path = MACOS_MANAGED_PREFERENCES_PATH;
  let present: boolean;
  try { present = await deps.exists(path); } catch { throw new ManagedPolicyFileError(path, "the profile cannot be checked"); }
  if (!present) return undefined;
  let converted;
  try { converted = await deps.run(PLUTIL, ["-convert", "json", "-o", "-", path]); } catch { throw new ManagedPolicyFileError(path, "the profile cannot be read"); }
  if (converted.code !== 0) throw new ManagedPolicyFileError(path, "the profile cannot be read");
  return { source: path, document: decodePolicyDocument(path, unwrapForced(converted.stdout)) };
}

async function readFile(deps: PolicyReadDeps): Promise<Record<string, unknown> | undefined> {
  const path = MACOS_MANAGED_POLICY_FILE;
  let present: boolean;
  try { present = await deps.exists(path); } catch { throw new ManagedPolicyFileError(path, "the file cannot be checked"); }
  if (!present) return undefined;
  let raw: string;
  try { raw = await deps.readText(path); } catch { throw new ManagedPolicyFileError(path, "the file cannot be read"); }
  return decodePolicyDocument(path, raw);
}

/** readManagedPolicy("darwin"): undefined without a policy; throws ManagedPolicyFileError when it cannot be used. */
export async function readMacManagedPolicy(deps: PolicyReadDeps): Promise<ManagedPolicyRead | undefined> {
  const [profile, file] = await Promise.all([readProfile(deps), readFile(deps)]);
  if (profile !== undefined && file !== undefined) {
    throw new ManagedPolicyFileError(profile.source, `a policy file at ${MACOS_MANAGED_POLICY_FILE} also exists; deploy the policy one way`);
  }
  return profile ?? (file === undefined ? undefined : { source: MACOS_MANAGED_POLICY_FILE, document: file });
}

let cached: Promise<ManagedPolicyRead | undefined> | null = null;

function defaultDeps(): PolicyReadDeps {
  return {
    exists: async (path) => (await desktop().fileSize(path)) !== null,
    readText: (path) => readTextFile(path, "utf8"),
    run: (command, args) => desktop().run(command, args, { timeoutMs: 10_000 }),
  };
}

/** DesktopManagedPolicy.read: at most once per launch. */
export function desktopManagedPolicy(): Promise<ManagedPolicyRead | undefined> {
  if (!isMac()) return Promise.resolve(undefined);
  cached ??= readMacManagedPolicy(defaultDeps());
  return cached;
}

/** DesktopStartupRecovery's ManagedPolicy text, with the error as its details. */
export const MANAGED_POLICY_STARTUP_TEXT = "Your organization's managed policy stopped T3 Code from starting. Send the details below to your IT administrator.";

export function installManagedPolicyCheck(): void {
  void desktopManagedPolicy().catch((error: unknown) => {
    presentStartupRecovery({ kind: "managed-policy", message: error instanceof Error ? error.message : String(error) });
  });
}

/** The startup recovery screen's Retry on a managed-policy offer: forces a fresh read (an administrator may have
 * just fixed the profile or the file) and re-presents the offer if it still cannot be used. */
export function retryManagedPolicyCheck(): void {
  cached = null;
  installManagedPolicyCheck();
}
