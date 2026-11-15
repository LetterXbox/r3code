import { mount, Scroll } from "nsh";
import { SettingsPageContainer } from "../../components/SettingsLayout";
import { restoreSavedSettings } from "../../store";
import { AppearanceSettings } from "./Appearance";

// What an older build left in the app's storage: Grove picked for both modes, the Light scheme.
restoreSavedSettings(JSON.stringify({ themeLight: "grove", themeDark: "grove", colorScheme: "light" }));

mount(() => (
  <Scroll class="flex-1">
    <SettingsPageContainer>
      <AppearanceSettings />
    </SettingsPageContainer>
  </Scroll>
));
