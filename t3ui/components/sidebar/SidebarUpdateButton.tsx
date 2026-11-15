// SidebarUpdatePill, idle state: a size-8 round refresh button at the right end of the footer,
// "Check for updates". The app has no desktop updater, so the check is the provider half of the
// web's: server.refreshProviders, whose result the Providers settings and the provider update pill
// read. The icon dims and the tooltip reads "Checking for updates..." while it runs.
import { signal, token, View } from "nsh";
import { backendStatus, refreshProviderStatuses } from "../../store";
import { Glyph } from "./SidebarGlyph";
import { Tip } from "./Tip";
import { threadActionNotice } from "./threadActions";

const checking = signal(false);

export async function checkForUpdates(): Promise<void> {
  if (checking() || backendStatus() !== "connected") return;
  checking.set(true);
  try {
    await refreshProviderStatuses({ fresh: true });
  } catch (error) {
    threadActionNotice.failure("Could not check for updates", error);
  } finally {
    checking.set(false);
  }
}

export const updateCheckLabel = () => (checking() ? "Checking for updates…" : "Check for updates");

export function SidebarUpdateButton() {
  const hovered = signal(false);
  const disabled = () => checking() || backendStatus() !== "connected";
  return (
    <View
      accessibilityLabel={updateCheckLabel()}
      role="button"
      tooltip={<Tip label={updateCheckLabel()} />}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onPress={() => { void checkForUpdates(); }}
      class={`ml-auto size-8 items-center justify-center rounded-full transition-colors duration-150 ease-in-out ${disabled() ? "opacity-60" : hovered() ? "bg-sidebar-row-hover" : ""}`}
    >
      <Glyph name="refresh-cw" size={16} tint={hovered() && !disabled() ? token("sidebar-foreground") : token("icon-muted")} />
    </View>
  );
}
