// cloud/cloudLinkState.ts usePrimaryCloudLinkState + useCloudLinkController for the primary environment, shared by the MCP wizard,
// the Welcome phone band and the onboarding dialog so they read one link state (the reference shares one atom per environment).
import { createCloudLinkController } from "../pages/settings/environments/CloudLinkRow";
import { serverEnvironment } from "../pages/settings/settingsState";
import { hasCloudPublicConfig } from "./publicConfig";
import { primaryEnvironmentScope, RELAY_READ_SCOPE } from "./t3ConnectState";

export const primaryEnvironmentId = (): string | null => {
  const id = serverEnvironment()?.environmentId;
  return typeof id === "string" ? id : null;
};

export const primaryCloudLink = createCloudLinkController(primaryEnvironmentId);

/** refreshCloudLinkState: only with the public config and relay:read, as the reference's atom is only built then. */
export function refreshPrimaryCloudLink(): Promise<void> | void {
  if (primaryEnvironmentId() !== null && hasCloudPublicConfig() && primaryEnvironmentScope(RELAY_READ_SCOPE)) return primaryCloudLink.refresh();
}
