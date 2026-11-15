import { expect, test } from "nsh/test";
import { contractErrorMessage } from "./backend/client";

// The server contract errors whose `message` is a getter: only their fields cross the wire, so the text is rebuilt here.
test("server contract errors read as the reference's message getter", () => {
  expect(contractErrorMessage({ _tag: "ServerProviderUpdateError", provider: "codex", reason: "npm exited with 1" })).toBe("Provider update failed for codex: npm exited with 1");
  expect(contractErrorMessage({ _tag: "ServerSelfUpdateError", reason: "registry offline" })).toBe("Server update failed: registry offline");
  expect(contractErrorMessage({ _tag: "ServerNpmReleaseError", reason: "ENOTFOUND" })).toBe("Could not check the configured npm registry: ENOTFOUND");
  expect(contractErrorMessage({ _tag: "DatabaseReclaimError", reason: "Database is locked" })).toBe("Database is locked");
  expect(contractErrorMessage({ _tag: "ServerPrepareTriageError" })).toBe("Could not write the triage session files.");
  expect(contractErrorMessage({ _tag: "KeybindingsConfigParseError", configPath: "/h/keybindings.json", detail: "Unexpected token" })).toBe("Unable to parse keybindings config at /h/keybindings.json: Unexpected token");
  expect(contractErrorMessage({ _tag: "GuestShareCreateError", reason: "connect_unavailable" })).toBe("Guest links need a running T3 Connect tunnel.");
  expect(contractErrorMessage({ _tag: "GuestShareCreateError", reason: "disabled" })).toBe("Guest links are off. Turn them on in Settings > Labs.");
});

test("server settings errors name the managed setting, the disallowed provider or the failed operation", () => {
  expect(contractErrorMessage({ _tag: "ServerSettingsError", operation: "write-managed-setting", managedSetting: "providers.codex", managedBy: "Acme", settingsPath: "/s" })).toBe("providers.codex is managed by Acme and cannot be changed.");
  expect(contractErrorMessage({ _tag: "ServerSettingsError", operation: "use-disallowed-provider", managedBy: "Acme", providerLabel: "Codex", settingsPath: "/s" })).toBe("Acme's policy does not allow the Codex provider.");
  expect(contractErrorMessage({ _tag: "ServerSettingsError", operation: "write-file", providerInstanceId: "codex", settingsPath: "/s/settings.json" })).toBe("Server settings write-file failed for provider codex at /s/settings.json.");
});
