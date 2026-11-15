import { mount, View } from "nsh";
import { SettingsPanel } from "./Panel";

mount(() => (
  <View class="flex-1">
    <SettingsPanel path="/settings/browser" />
  </View>
));
