// SidebarStageBackdrop.tsx (DevBlueprintArt / NightlySkyArt): the artwork behind the sidebar header, 80pt
// tall, pinned to the top-left of the column so it keeps its scale as the sidebar resizes, fading into the
// sidebar surface by the bottom (sidebar-stage-backdrop). The SVGs carry the palette and the fade, because
// NSH cannot mask or composite a gradient over an image. The reference colours the art through its theme's
// custom properties, so it follows a theme change at once; here the theme that is showing (builtTheme.ts:
// what the bundle was built with, then whatever a live theme.setOverrides applied) picks the matching file
// from stage/themes. A theme with no art of its own never shows this (environmentIdentification.ts); the
// four files beside this folder are the fallback the launcher's themed build repaints.
import { colorScheme, Image, View } from "nsh";
import type { ImageAsset } from "nsh";
import dark from "./stage/blueprint-dark.svg";
import light from "./stage/blueprint-light.svg";
import nightlyDark from "./stage/nightly-dark.svg";
import nightlyLight from "./stage/nightly-light.svg";
import { stageArtSource } from "./stage/stageArt";
import { builtThemeForMode } from "../../pages/settings/builtTheme";

export const STAGE_BACKDROP_HEIGHT = 80;

/** The art file for a stage in a scheme under a theme (the build's own file when the theme has none). */
export function stageBackdropSource(variant: "dev" | "nightly", themeId: string, scheme: "light" | "dark"): ImageAsset {
  const themed = stageArtSource(variant === "nightly" ? "nightly" : "blueprint", themeId, scheme);
  if (themed !== null) return themed;
  return variant === "nightly" ? (scheme === "dark" ? nightlyDark : nightlyLight) : scheme === "dark" ? dark : light;
}

/** `variant`: the stage whose art is drawn (environment identification); the Dev blueprint unless told otherwise. */
export function SidebarStageBackdrop(props: { width: number; variant?: "dev" | "nightly" }) {
  const scheme = () => (colorScheme() === "dark" ? "dark" : "light");
  return (
    <View
      accessibilityLabel="Sidebar backdrop"
      class="absolute inset-x-0 top-0 overflow-hidden"
      style={{ height: STAGE_BACKDROP_HEIGHT, pointerEvents: "none" }}
    >
      <Image
        src={stageBackdropSource(props.variant === "nightly" ? "nightly" : "dev", builtThemeForMode(scheme()), scheme())}
        style={{ width: props.width, height: STAGE_BACKDROP_HEIGHT, objectFit: "cover", objectPosition: "left top" }}
      />
    </View>
  );
}
