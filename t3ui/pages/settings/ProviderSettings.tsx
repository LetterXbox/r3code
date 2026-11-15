// Settings > Providers. The panel itself is ProviderPanel (a port of ProviderSettingsPanel.tsx);
// this wires it to the connected environment.
import { liveProviderApi, useProviderConfigStream, type ProviderApi } from "./providers/data";
import { ProviderPanel } from "./providers/ProviderPanel";

export function ProviderSettings(props: { api?: ProviderApi } = {}) {
  if (!props.api) useProviderConfigStream();
  return <ProviderPanel api={props.api ?? liveProviderApi} />;
}
