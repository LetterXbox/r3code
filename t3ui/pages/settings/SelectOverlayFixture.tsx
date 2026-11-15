import { mount, Text, View } from "nsh";
import { SettingsPanel } from "./Panel";
import { registeredOverlays } from "../../components/rightPanel/nativeOcclusion";

mount(() => (
  <View class="flex-1">
    <Text>{`overlays: ${registeredOverlays().length}`}</Text>
    <SettingsPanel path="/settings/general" />
  </View>
));
