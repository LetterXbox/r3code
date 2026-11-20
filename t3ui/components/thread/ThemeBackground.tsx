import { cleanup, colorScheme, computed, effect, Image, signal, View } from "nsh";
import { assetUrlFor } from "../sidebar/projectIcon";
import { customThemes } from "../../pages/settings/customThemes";
import { environmentThemeById } from "../../pages/settings/environmentThemes";
import { desiredTheme } from "../../pages/settings/themeRequest";
import { backendConnectionGeneration, backendStatus, backendUrl, requestBackend } from "../../store";

export function ThemeBackground() {
  const source = signal<string | null>(null);
  // Depend on the revision so replacing the same file also refreshes the URL.
  const selected = computed(() => {
    const id = desiredTheme()[colorScheme() === "light" ? "light" : "dark"];
    const theme = environmentThemeById(id);
    return theme?.background && !customThemes().some((saved) => saved.id === id)
      ? JSON.stringify([id, theme.background])
      : null;
  });
  effect(() => {
    source.set(null);
    if (backendStatus() !== "connected" || selected() === null) return;
    const endpoint = backendUrl();
    const generation = backendConnectionGeneration();
    const themeId = desiredTheme()[colorScheme() === "light" ? "light" : "dark"];
    let current = true;
    const refresh = async () => {
      try {
        const result = await requestBackend("assets.createUrl", {
          resource: { _tag: "environment-theme-background", themeId },
        });
        if (current && backendConnectionGeneration() === generation) {
          const relativeUrl = result && typeof result === "object" && "relativeUrl" in result ? result.relativeUrl : null;
          source.set(assetUrlFor(endpoint, relativeUrl));
        }
      } catch {
        if (current) source.set(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 25 * 60_000);
    cleanup(() => { current = false; clearInterval(timer); });
  });
  return () => {
    const url = source();
    return url ? (
      <View class="absolute inset-0" style={{ pointerEvents: "none" }}>
        <Image src={url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </View>
    ) : null;
  };
}
