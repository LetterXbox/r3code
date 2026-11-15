// The Appearance panel with the theme-request watcher installed on a stand-in for the launcher: requests land in
// storage (theme-request, theme-request-count) and a request that asks for Iris dark is answered with a failure.
import { mount, Scroll, Storage, Text, View } from "nsh";
import { SettingsPageContainer } from "../../components/SettingsLayout";
import { ShellOverlays } from "../../shell/ShellOverlays";
import { updateSetting } from "../../store";
import { AppearanceSettings } from "./Appearance";
import { builtThemeForMode, setBuiltTheme } from "./builtTheme";
import { resetCustomThemes } from "./customThemes";
import { installThemeSync } from "./themeRequest";

// A bundle the launcher built in Grove (light) and Ember (dark) at contrast 120.
resetCustomThemes([{ id: "midnight", label: "Midnight", appearance: "dark", colors: { canvas: "#010203" } }]);
setBuiltTheme({ light: "grove", dark: "ember", contrast: 120 });
// What the user's saved settings say after the launcher built that: the same choices.
updateSetting("themeLight", "grove");
updateSetting("themeDark", "ember");
updateSetting("appearanceContrast", 120);

let count = 0;
installThemeSync({
  pickDelayMs: 5,
  contrastDelayMs: 300,
  pollMs: 5,
  timeoutMs: 2000,
  io: {
    async writeRequest(text) {
      count += 1;
      await Storage.setItem("theme-request", text);
      await Storage.setItem("theme-request-count", String(count));
    },
    async readStatus() {
      const text = await Storage.getItem("theme-request");
      const request = text ? JSON.parse(text) : null;
      if (request && request.themeDark === "iris") return JSON.stringify({ requestId: request.requestId, ok: false, message: "The UI did not build with that theme." });
      return null;
    },
  },
});

function Button(props: { label: string; onPress: () => void }) {
  return <View role="button" accessibilityLabel={props.label} onPress={props.onPress}><Text>{props.label}</Text></View>;
}

mount(() => (
  <View class="flex-1">
    <Button label="Contrast sweep" onPress={() => { updateSetting("appearanceContrast", 130); setTimeout(() => updateSetting("appearanceContrast", 135), 20); setTimeout(() => updateSetting("appearanceContrast", 140), 40); }} />
    <Text>{`built ${builtThemeForMode("light")} ${builtThemeForMode("dark")}`}</Text>
    <Scroll class="flex-1">
      <SettingsPageContainer>
        <AppearanceSettings />
      </SettingsPageContainer>
    </Scroll>
    <ShellOverlays />
  </View>
));
