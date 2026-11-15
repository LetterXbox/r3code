import { mount, View } from "nsh";
import { SavedSessionPermissions } from "./Connection";

mount(() => (
  <View class="flex-1 gap-4 p-4">
    <SavedSessionPermissions url="wss://build.example/ws" connected read={() => Promise.resolve({ authenticated: true, permissions: ["settings:write"] })} />
  </View>
));
