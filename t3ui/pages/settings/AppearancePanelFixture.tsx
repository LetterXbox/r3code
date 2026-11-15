import { mount, Scroll } from "nsh";
import { SettingsPanel } from "./Panel";

mount(() => (
  <Scroll class="flex-1">
    <SettingsPanel path="/settings/appearance" />
  </Scroll>
));
