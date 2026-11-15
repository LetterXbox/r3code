import { mount, View } from "nsh";
import { SettingsButton } from "../SettingsLayout";
import { DeviceLoadingView } from "./DeviceLoadingView";

mount(() => (
  <View class="flex-1 gap-4 p-4">
    <View class="h-64"><DeviceLoadingView name="iPhone 15" description="This machine · 17.2" stage="opening" message="Starting device…" /></View>
    <View class="h-64"><DeviceLoadingView name="Pixel 8" stage="stream" message="Stream failed." error><SettingsButton label="Reconnect" onPress={() => {}} /></DeviceLoadingView></View>
  </View>
));
