// The web's usePullRequestsSupported (state/environments -> presentation.pullRequestsSupportedAtom): the Pull requests
// entry and page exist once some environment has delivered its server config. Until then (no connection) the
// sidebar offers no Pull requests button.
import { serverEnvironment, serverSettings } from "../../pages/settings/settingsState";
import { environmentConfigs } from "../../environments/connectionManager";

export function pullRequestsSupported(): boolean {
  return serverEnvironment() !== null || serverSettings() !== null || Object.keys(environmentConfigs()).length > 0;
}
