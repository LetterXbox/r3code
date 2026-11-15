// The unfaded compact stage-art slices used by the composer button, generated for every supported
// theme and appearance by tools/build_stage_art.py. The reference draws these as inline SVGs.
import type { ImageAsset } from "nsh";
import default_blueprint_light from "./button-themes/default-blueprint-light.svg";
import default_blueprint_dark from "./button-themes/default-blueprint-dark.svg";
import default_nightly_light from "./button-themes/default-nightly-light.svg";
import default_nightly_dark from "./button-themes/default-nightly-dark.svg";
import t3_chat_blueprint_light from "./button-themes/t3-chat-blueprint-light.svg";
import t3_chat_blueprint_dark from "./button-themes/t3-chat-blueprint-dark.svg";
import t3_chat_nightly_light from "./button-themes/t3-chat-nightly-light.svg";
import t3_chat_nightly_dark from "./button-themes/t3-chat-nightly-dark.svg";
import grove_blueprint_light from "./button-themes/grove-blueprint-light.svg";
import grove_blueprint_dark from "./button-themes/grove-blueprint-dark.svg";
import grove_nightly_light from "./button-themes/grove-nightly-light.svg";
import grove_nightly_dark from "./button-themes/grove-nightly-dark.svg";
import ocean_blueprint_light from "./button-themes/ocean-blueprint-light.svg";
import ocean_blueprint_dark from "./button-themes/ocean-blueprint-dark.svg";
import ocean_nightly_light from "./button-themes/ocean-nightly-light.svg";
import ocean_nightly_dark from "./button-themes/ocean-nightly-dark.svg";
import ember_blueprint_light from "./button-themes/ember-blueprint-light.svg";
import ember_blueprint_dark from "./button-themes/ember-blueprint-dark.svg";
import ember_nightly_light from "./button-themes/ember-nightly-light.svg";
import ember_nightly_dark from "./button-themes/ember-nightly-dark.svg";
import iris_blueprint_light from "./button-themes/iris-blueprint-light.svg";
import iris_blueprint_dark from "./button-themes/iris-blueprint-dark.svg";
import iris_nightly_light from "./button-themes/iris-nightly-light.svg";
import iris_nightly_dark from "./button-themes/iris-nightly-dark.svg";

export type StageArt = "blueprint" | "nightly";
export type StageScheme = "light" | "dark";

const ART: Record<string, Record<StageArt, Record<StageScheme, ImageAsset>>> = {
  "default": {
    blueprint: { light: default_blueprint_light, dark: default_blueprint_dark },
    nightly: { light: default_nightly_light, dark: default_nightly_dark },
  },
  "t3-chat": {
    blueprint: { light: t3_chat_blueprint_light, dark: t3_chat_blueprint_dark },
    nightly: { light: t3_chat_nightly_light, dark: t3_chat_nightly_dark },
  },
  "grove": {
    blueprint: { light: grove_blueprint_light, dark: grove_blueprint_dark },
    nightly: { light: grove_nightly_light, dark: grove_nightly_dark },
  },
  "ocean": {
    blueprint: { light: ocean_blueprint_light, dark: ocean_blueprint_dark },
    nightly: { light: ocean_nightly_light, dark: ocean_nightly_dark },
  },
  "ember": {
    blueprint: { light: ember_blueprint_light, dark: ember_blueprint_dark },
    nightly: { light: ember_nightly_light, dark: ember_nightly_dark },
  },
  "iris": {
    blueprint: { light: iris_blueprint_light, dark: iris_blueprint_dark },
    nightly: { light: iris_nightly_light, dark: iris_nightly_dark },
  },
};

/** The theme ids with art of their own (themeAllowsSidebarArtwork's built-ins, and the standard theme). */
export const STAGE_BUTTON_ART_THEME_IDS: readonly string[] = Object.keys(ART);

/** The art file for `themeId` in `scheme`, or null for a theme that has none (a custom theme: the
 * reference never shows it the art, and the caller keeps the build's own default file). */
export function stageButtonArtSource(art: StageArt, themeId: string, scheme: StageScheme): ImageAsset | null {
  return ART[themeId]?.[art][scheme] ?? null;
}
