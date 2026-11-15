// The provider status alert for a signed-out Claude instance.
import { mount, Text, View } from "nsh";
import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { providerSelectionRequest } from "../../pages/settings/providers/data";
import type { ProviderStatus } from "../../store";

const status: ProviderStatus = {
  instanceId: "claude-work", driver: "claudeAgent", name: "Claude Work", enabled: true, installed: true, available: false, status: "error",
  authStatus: "unauthenticated", authLabel: null, version: "2.0.0", unavailableReason: null, message: "Claude is not signed in.", checkedAt: null,
  canInstall: false, canAuthenticate: true, models: [],
};
mount(() => <View class="flex-1">
  <ProviderStatusBanner status={() => status} onDismiss={() => {}} />
  <Text>{`setup ${providerSelectionRequest() ?? "none"}`}</Text>
</View>);
