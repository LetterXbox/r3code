// The Appearance panel with the theme-request watcher installed on a stand-in for a host that supports
// live theme overrides (third_party/nsh-host/README.md "live theme"): `isLiveCapable` and `callHost` are
// injected (a headless `nsh test` run has no real host bridge to exercise), so this fixture proves the
// capability-present branch of themeRequest.ts end to end: no theme-request.json write, a call of
// `theme.setOverrides`, and the selection updating without ever showing "Applying theme" past that call's
// resolution. A request for Iris dark is answered with a live failure, mirroring the rebuild fixture's
// failure case.
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
updateSetting("themeLight", "grove");
updateSetting("themeDark", "ember");
updateSetting("appearanceContrast", 120);

let liveRequestCount = 0;
let hostCallCount = 0;

installThemeSync({
  pickDelayMs: 5,
  contrastDelayMs: 300,
  pollMs: 5,
  timeoutMs: 2000,
  isLiveCapable: () => true,
  callHost: async (name, data) => {
    hostCallCount += 1;
    await Storage.setItem("host-call-count", String(hostCallCount));
    await Storage.setItem("host-call-name", name);
    await Storage.setItem("host-call-data", JSON.stringify(data));
    const theme = data as { cssVars?: { dark?: Record<string, unknown> } };
    const darkValue = String(theme.cssVars?.dark?.["background"] ?? "");
    await Storage.setItem("host-started", darkValue);
    if (darkValue === "built-ocean") await new Promise((resolve) => setTimeout(resolve, 400));
    if (theme.cssVars?.dark?.["background"] === "IRIS-FAIL") throw new Error("The host rejected that theme.");
    await Storage.setItem("host-finished", darkValue);
    return { applied: true };
  },
  io: {
    // The rebuild path must never be used while live capable: a write here would show up in storage.
    async writeRequest(text) {
      await Storage.setItem("theme-request", text);
    },
    async readStatus() {
      return null;
    },
    async writeLiveRequest(text) {
      liveRequestCount += 1;
      await Storage.setItem("theme-live-request", text);
      await Storage.setItem("theme-live-request-count", String(liveRequestCount));
    },
    async readLiveStatus() {
      const text = await Storage.getItem("theme-live-request");
      const request = text ? JSON.parse(text) : null;
      if (!request) return null;
      return JSON.stringify({ requestId: request.requestId, ok: true });
    },
    async readLiveResult() {
      const text = await Storage.getItem("theme-live-request");
      const request = text ? JSON.parse(text) : null;
      if (!request) return null;
      const dark = request.themeDark === "iris" ? "IRIS-FAIL" : `built-${request.themeDark}`;
      return JSON.stringify({
        requestId: request.requestId,
        theme: { cssVars: { theme: {}, light: {}, dark: { background: dark } } },
        meta: { light: request.themeLight, dark: request.themeDark, contrast: request.contrast },
      });
    },
    async writeLast(text) {
      const request = JSON.parse(text) as { themeDark?: string };
      if (request.themeDark === "ocean") await new Promise((resolve) => setTimeout(resolve, 400));
      await Storage.setItem("theme-last", text);
    },
  },
});

function Button(props: { label: string; onPress: () => void }) {
  return <View role="button" accessibilityLabel={props.label} onPress={props.onPress}><Text>{props.label}</Text></View>;
}

mount(() => (
  <View class="flex-1">
    <Text>{`built ${builtThemeForMode("light")} ${builtThemeForMode("dark")}`}</Text>
    <Scroll class="flex-1">
      <SettingsPageContainer>
        <AppearanceSettings />
      </SettingsPageContainer>
    </Scroll>
    <ShellOverlays />
  </View>
));
