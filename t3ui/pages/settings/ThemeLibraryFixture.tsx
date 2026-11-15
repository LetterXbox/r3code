import { mount, Scroll, View } from "nsh";
import { ShellOverlays } from "../../shell/ShellOverlays";
import { SettingsPageContainer } from "../../components/SettingsLayout";
import { AppearanceSettings } from "./Appearance";

mount(() => (
  <View class="flex-1">
    <Scroll class="flex-1">
      <SettingsPageContainer>
        <AppearanceSettings />
      </SettingsPageContainer>
    </Scroll>
    <ShellOverlays />
  </View>
));
