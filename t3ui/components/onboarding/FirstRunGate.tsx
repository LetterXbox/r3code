// components/onboarding/FirstRunGate.tsx: what covers the shell while the first-run decision is open. Pending shows nothing but the
// background (the web renders null, so no flash of the app before the Welcome page). "Could not read settings" and "Still
// connecting" are the web's recovery pages. A decided wizard shows the Welcome page; Settings opened over it shows as asked, so
// setup can never lock a user out of the app.
import { Text, View } from "nsh";
import { backendUrl, configureBackend, settingsOpen } from "../../store";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import {
  closeWelcomePage,
  effectiveFirstRunDecision,
  effectiveFirstRunStalled,
  ensureOnboardingHydrated,
  onboardingHydration,
  welcomeReopenedFromSettings,
} from "./firstRunState";
import { WelcomePage } from "./WelcomePage";

export type FirstRunCover = "none" | "blank" | "settings-failed" | "connection-stalled" | "welcome";

/** What the gate shows, from its inputs (FirstRunGate's render branches). */
export function firstRunCover(input: { decision: "pending" | "app" | "wizard"; stalled: boolean; settingsFailed: boolean; reopened: boolean; settingsOpen: boolean }): FirstRunCover {
  if (input.settingsFailed) return "settings-failed";
  if (input.settingsOpen) return "none";
  if (input.decision === "wizard" || input.reopened) return "welcome";
  if (input.decision === "pending") return input.stalled ? "connection-stalled" : "blank";
  return "none";
}

export const currentFirstRunCover = (): FirstRunCover => firstRunCover({
  decision: effectiveFirstRunDecision(),
  stalled: effectiveFirstRunStalled(),
  settingsFailed: onboardingHydration() === "failed",
  reopened: welcomeReopenedFromSettings(),
  settingsOpen: settingsOpen(),
});

function Recovery(props: { title: string; body: string; action: string; onPress: () => void }) {
  return (
    <View class="absolute inset-0 z-30 flex-1 items-center justify-center bg-background px-6" role="alert" accessibilityLabel={props.title}>
      <View class="max-w-sm items-center">
        <Text class="text-lg font-semibold text-foreground">{props.title}</Text>
        <Text class="mt-2 text-center text-sm text-muted-foreground">{props.body}</Text>
        <View role="button" accessibilityLabel={props.action} onPress={props.onPress} class="mt-5 h-8 items-center justify-center rounded-lg border border-input bg-popover px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <Text class="text-sm font-medium text-foreground">{props.action}</Text>
        </View>
      </View>
    </View>
  );
}

export function FirstRunGate() {
  useOverlayOpen(() => currentFirstRunCover() !== "none", "first run");
  return (
    <>
      {currentFirstRunCover() === "blank" ? <View class="absolute inset-0 z-30 bg-background" desktop={{ windowDrag: true }} accessibilityLabel="Starting" /> : null}
      {currentFirstRunCover() === "settings-failed" ? (
        <Recovery title="Could not read settings" body="Your saved settings could not be loaded." action="Retry" onPress={() => void ensureOnboardingHydrated()} />
      ) : null}
      {currentFirstRunCover() === "connection-stalled" ? (
        // The web reloads the window; the app's reload is a fresh connection to the same environment.
        <Recovery title="Still connecting" body="R3 Code could not confirm this workspace." action="Reload" onPress={() => configureBackend(backendUrl())} />
      ) : null}
      {currentFirstRunCover() === "welcome" ? <WelcomePage onDone={closeWelcomePage} /> : null}
    </>
  );
}
