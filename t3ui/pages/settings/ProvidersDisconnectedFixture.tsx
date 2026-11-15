// The Providers page with nothing connected (no backend configured): what the route shows before ProviderSettingsPanel mounts.
import { mount, View } from "nsh";
import { SettingsPanel } from "./Panel";

mount(() => <View class="flex-1"><SettingsPanel path="/settings/providers" /></View>);
