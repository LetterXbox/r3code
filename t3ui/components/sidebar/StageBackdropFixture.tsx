// The sidebar art under a theme applied live: the buttons do what themeRequest.ts does after the host
// has taken theme.setOverrides (setBuiltTheme), and the text is the file the backdrop then draws.
import { colorScheme, mount, Text, View } from "nsh";
import { SidebarStageBackdrop, stageBackdropSource } from "./SidebarStageBackdrop";
import { STAGE_ART_THEME_IDS, stageArtSource } from "./stage/stageArt";
import { builtThemeForMode, setBuiltTheme } from "../../pages/settings/builtTheme";

const scheme = () => (colorScheme() === "dark" ? "dark" : "light");
const distinct = () => {
  const seen = new Set<unknown>();
  for (const id of STAGE_ART_THEME_IDS) for (const art of ["blueprint", "nightly"] as const) for (const mode of ["light", "dark"] as const) seen.add(stageArtSource(art, id, mode));
  return seen.size;
};
/** Which theme's file the backdrop draws for a stage: "<theme>/<scheme>", or "build" for the build's own. */
const drawn = (variant: "dev" | "nightly") => {
  const source = stageBackdropSource(variant, builtThemeForMode(scheme()), scheme());
  for (const id of STAGE_ART_THEME_IDS) for (const mode of ["light", "dark"] as const) {
    if (stageArtSource(variant === "dev" ? "blueprint" : "nightly", id, mode) === source) return `${id}/${mode}`;
  }
  return "build";
};

function Fixture() {
  return (
    <View class="w-[300px] gap-2 bg-sidebar p-2">
      <View class="relative h-20"><SidebarStageBackdrop width={300} variant="dev" /></View>
      <Text accessibilityLabel="Dev art">{`dev:${drawn("dev")}`}</Text>
      <Text accessibilityLabel="Nightly art">{`nightly:${drawn("nightly")}`}</Text>
      <Text accessibilityLabel="Art count">{`themes:${STAGE_ART_THEME_IDS.join(",")} files:${distinct()}`}</Text>
      <Text accessibilityLabel="Custom art">{`custom:${String(stageArtSource("blueprint", "my-custom-theme", "dark"))}`}</Text>
      <View role="button" accessibilityLabel="Apply ember" onPress={() => setBuiltTheme({ light: "ember", dark: "ember", contrast: 100 })}><Text>Apply ember</Text></View>
      <View role="button" accessibilityLabel="Apply split" onPress={() => setBuiltTheme({ light: "grove", dark: "iris", contrast: 100 })}><Text>Apply split</Text></View>
      <View role="button" accessibilityLabel="Apply custom" onPress={() => setBuiltTheme({ light: "my-custom-theme", dark: "my-custom-theme", contrast: 100 })}><Text>Apply custom</Text></View>
    </View>
  );
}

mount(Fixture);
