// browserImportWizard.logic.ts: the steps of the cookie import wizard (BrowserImportWizard.tsx). The wizard reads another
// browser's profiles through the desktop shell's bridge, which a native client does not have, so the Import from menu
// lists no browser (the reference's own "No supported browsers found") and this wizard opens only when a source is
// given (BrowserImportWizard.tsx draws its steps from this logic).
export type BrowserImportFailureReason =
  | "browserRunning" | "needsFullDiskAccess" | "needsKeychainApproval" | "keychainItemMissing" | "keychainUnavailable"
  | "readFailed" | "sessionUnavailable" | "profileNotSaved" | "unknownSource" | "unknownSourceProfile" | "notInstalled" | "unsupportedPlatform";
export interface BrowserImportSource {
  readonly id: string;
  readonly name: string;
  readonly unavailable?: BrowserImportFailureReason | undefined;
  readonly profiles: ReadonlyArray<{ readonly directory: string; readonly name?: string; readonly cookieCount?: number }>;
}

export interface WizardTargetProfile {
  readonly id: string;
  readonly name: string;
}

export type WizardTarget =
  | { readonly kind: "new"; readonly profileId: string }
  | { readonly kind: "existing"; readonly profileId: string; readonly name: string };

export type WizardTargetSelection =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly profileId: string };

export function initialTargetSelection(
  canCreateProfile: boolean,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTargetSelection {
  if (canCreateProfile) return { kind: "new" };
  const first = targetProfiles[0];
  return first ? { kind: "existing", profileId: first.id } : { kind: "new" };
}

export function resolveWizardTarget(
  selection: WizardTargetSelection,
  newProfileId: string,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTarget | undefined {
  if (selection.kind === "new") return { kind: "new", profileId: newProfileId };
  const profile = targetProfiles.find((candidate) => candidate.id === selection.profileId);
  if (profile === undefined) return undefined;
  return {
    kind: "existing",
    profileId: selection.profileId,
    name: profile.name,
  };
}

export type ImportOutcome =
  | {
      readonly kind: "imported";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
    }
  | {
      readonly kind: "blocked";
      readonly reason: BrowserImportFailureReason;
      /** Shown instead of the reason's copy, such as a managed policy's refusal. */
      readonly message?: string;
    };

export type WizardStep =
  | { readonly step: "quit" }
  | {
      readonly step: "fullDiskAccess";
      readonly resume: "configure" | "import";
      readonly checked?: boolean;
    }
  | { readonly step: "configure" }
  | { readonly step: "checking"; readonly check: "browser" | "fullDiskAccess" }
  | { readonly step: "importing" }
  | {
      readonly step: "done";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
    }
  | {
      readonly step: "blocked";
      readonly reason: BrowserImportFailureReason;
      readonly message?: string;
    };

export function canCloseWizard(step: WizardStep): boolean {
  return step.step !== "importing";
}

export function initialWizardStep(source: BrowserImportSource): WizardStep {
  if (source.unavailable === "browserRunning") return { step: "quit" };
  if (source.unavailable === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "configure" };
  }
  if (source.unavailable !== undefined) return { step: "blocked", reason: source.unavailable };
  if (source.profiles.length === 0) return { step: "blocked", reason: "unknownSourceProfile" };
  return { step: "configure" };
}

export function outcomeToStep(outcome: ImportOutcome): WizardStep {
  if (outcome.kind === "imported") {
    return {
      step: "done",
      imported: outcome.imported,
      skipped: outcome.skipped,
      skippedDomains: outcome.skippedDomains,
      targetName: outcome.targetName,
    };
  }
  if (outcome.reason === "browserRunning") return { step: "quit" };
  if (outcome.reason === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "import", checked: true };
  }
  return outcome.message === undefined
    ? { step: "blocked", reason: outcome.reason }
    : { step: "blocked", reason: outcome.reason, message: outcome.message };
}

export function refreshedSourceStep(source: BrowserImportSource | undefined): WizardStep {
  if (source === undefined) return { step: "blocked", reason: "unknownSource" };
  return initialWizardStep(source);
}

export function fullDiskAccessRecheckStep(source: BrowserImportSource | undefined): WizardStep {
  const next = refreshedSourceStep(source);
  return next.step === "fullDiskAccess" ? { ...next, checked: true } : next;
}

export function refreshedSourceProfileDirectory(
  currentDirectory: string,
  source: BrowserImportSource,
): string {
  if (source.profiles.some((profile) => profile.directory === currentDirectory)) {
    return currentDirectory;
  }
  return source.profiles[0]?.directory ?? "";
}

export function isRetryableReason(reason: BrowserImportFailureReason): boolean {
  switch (reason) {
    case "needsKeychainApproval":
    case "keychainItemMissing":
    case "keychainUnavailable":
    case "readFailed":
    case "sessionUnavailable":
    case "profileNotSaved":
      return true;
    default:
      return false;
  }
}

export function formatSkippedDomains(domains: ReadonlyArray<string>): string {
  if (domains.length === 0) return "";
  if (domains.length === 1) return domains[0]!;
  if (domains.length <= 3) return `${domains.slice(0, -1).join(", ")} and ${domains.at(-1)}`;
  return `${domains.slice(0, 3).join(", ")} and ${domains.length - 3} more`;
}

/** BROWSER_IMPORT_FAILURE_COPY (packages/contracts/src/browserImport.ts): what each reason tells the user. */
export const BROWSER_IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  notInstalled: "Not installed on this machine.",
  needsKeychainApproval: "Needs Keychain access to read its cookies.",
  keychainItemMissing: "No encryption key in your Keychain. Sign in to that browser once, then retry.",
  needsFullDiskAccess: "Give R3 Code Full Disk Access in System Settings → Privacy & Security, then retry.",
  browserRunning: "Quit the browser first so its cookie database can be read.",
  unsupportedPlatform: "Importing from this browser isn't possible on this platform.",
  keychainUnavailable: "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  unknownSource: "That browser is no longer available to import from.",
  unknownSourceProfile: "That browser profile no longer exists.",
  sessionUnavailable: "The target profile could not be opened.",
  profileNotSaved: "The cookies were imported, but the new profile couldn't be saved. Try again.",
  readFailed: "The browser's cookie database could not be read.",
};

/** Sources the Import from menu lists: a browser that is installed and importable here (`importableSources`). */
export function importableSources(sources: ReadonlyArray<BrowserImportSource>): BrowserImportSource[] {
  return sources.filter((source) => source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform");
}

/** importFailureReason (IntegrationsSettings.tsx): the reason a desktop import error names, else readFailed. */
export function importFailureReason(cause: unknown): BrowserImportFailureReason {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (Object.keys(BROWSER_IMPORT_FAILURE_COPY) as BrowserImportFailureReason[]).find((reason) => message.includes(`failed: ${reason}.`)) ?? "readFailed";
}

/** importPolicyRefusal: the sentence of a managed policy's refusal, wrapped by IPC in prefixes of its own. */
export function importPolicyRefusal(cause: unknown): string | undefined {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return /The managed policy at .* importing browser cookies is not allowed\./u.exec(message)?.[0] ?? /(?:^|: )([^:]*'s policy does not allow importing browser cookies\.)/u.exec(message)?.[1];
}

/** cookieCountLabel / cookieResultCount (BrowserImportWizard.tsx). */
export function cookieCountLabel(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return "no cookies";
  return `${count.toLocaleString("en-US")} ${count === 1 ? "cookie" : "cookies"}`;
}
export const cookieResultCount = (count: number): string => `${count.toLocaleString("en-US")} ${count === 1 ? "cookie" : "cookies"}`;
