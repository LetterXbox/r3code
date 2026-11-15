// The sidebar stage art for every theme that paints it (the five built-in palettes and "default", the
// standard T3 Code theme), both arts, both schemes: stage/themes/<theme>-<art>-<scheme>.svg, written by
// `python3 tools/build_stage_art.py --all --out t3ui/components/sidebar/stage` from the reference's
// index.css (tools/test_build_stage_art.py fails when they drift). The reference draws the art as inline
// SVG coloured by its theme's --stage-art-* / --stage-night-* properties, so it recolours with the theme;
// here an applied theme (builtTheme.ts, set by a themed build or a live theme.setOverrides) picks a file.
import type { ImageAsset } from "nsh";
import default_blueprint_light from "./themes/default-blueprint-light.svg";
import default_blueprint_dark from "./themes/default-blueprint-dark.svg";
import default_nightly_light from "./themes/default-nightly-light.svg";
import default_nightly_dark from "./themes/default-nightly-dark.svg";
import t3_chat_blueprint_light from "./themes/t3-chat-blueprint-light.svg";
import t3_chat_blueprint_dark from "./themes/t3-chat-blueprint-dark.svg";
import t3_chat_nightly_light from "./themes/t3-chat-nightly-light.svg";
import t3_chat_nightly_dark from "./themes/t3-chat-nightly-dark.svg";
import grove_blueprint_light from "./themes/grove-blueprint-light.svg";
import grove_blueprint_dark from "./themes/grove-blueprint-dark.svg";
import grove_nightly_light from "./themes/grove-nightly-light.svg";
import grove_nightly_dark from "./themes/grove-nightly-dark.svg";
import ocean_blueprint_light from "./themes/ocean-blueprint-light.svg";
import ocean_blueprint_dark from "./themes/ocean-blueprint-dark.svg";
import ocean_nightly_light from "./themes/ocean-nightly-light.svg";
import ocean_nightly_dark from "./themes/ocean-nightly-dark.svg";
import ember_blueprint_light from "./themes/ember-blueprint-light.svg";
import ember_blueprint_dark from "./themes/ember-blueprint-dark.svg";
import ember_nightly_light from "./themes/ember-nightly-light.svg";
import ember_nightly_dark from "./themes/ember-nightly-dark.svg";
import iris_blueprint_light from "./themes/iris-blueprint-light.svg";
import iris_blueprint_dark from "./themes/iris-blueprint-dark.svg";
import iris_nightly_light from "./themes/iris-nightly-light.svg";
import iris_nightly_dark from "./themes/iris-nightly-dark.svg";

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
export const STAGE_ART_THEME_IDS: readonly string[] = Object.keys(ART);

/** The art file for `themeId` in `scheme`, or null for a theme that has none (a custom theme: the
 * reference never shows it the art, and the caller keeps the build's own default file). */
export function stageArtSource(art: StageArt, themeId: string, scheme: StageScheme): ImageAsset | null {
  return ART[themeId]?.[art][scheme] ?? null;
}
