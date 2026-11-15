// DeviceAndroidFoldControls.tsx: Fold device / Unfold device for a foldable Android emulator, in the controls rail. Shown
// once the hub says the device folds; reads the posture while visible and streaming (again when the screen size
// changes, because folding resizes it), and not while a change is in flight.
import { effect, signal, Text, untracked, View } from "nsh";
import { DIcon } from "./DeviceIcons";
import { androidFoldView, changeAndroidFold, startAndroidFoldRead, type AndroidFoldPosture } from "./deviceFold";
import type { DeviceHubAccess } from "./deviceStream";

export function DeviceAndroidFoldControls(props: {
  access: () => DeviceHubAccess | null;
  deviceKey: string;
  deviceId: string;
  visible: () => boolean;
  enabled: () => boolean;
  screen: () => { width: number; height: number } | null;
  renewAccess: () => Promise<DeviceHubAccess | null>;
  fetcher?: typeof fetch;
}) {
  const pending = signal(false);
  const error = signal<string | null>(null);
  let busy = false;
  const view = androidFoldView(props.deviceKey);
  // A change in flight owns the posture; reading meanwhile could show the old one.
  effect(() => {
    const access = props.access(); const screen = props.screen();
    if (!props.visible() || !props.enabled() || pending() || !access || !screen?.width || !screen.height) return;
    return untracked(() => startAndroidFoldRead({ deviceKey: props.deviceKey, access, deviceId: props.deviceId }, props.fetcher ? { fetcher: props.fetcher } : {}));
  });
  const change = (posture: AndroidFoldPosture) => {
    const access = props.access();
    if (busy || !props.enabled() || !access) return;
    busy = true; pending.set(true); error.set(null);
    void changeAndroidFold({ deviceKey: props.deviceKey, access, deviceId: props.deviceId, posture, renewAccess: props.renewAccess }, props.fetcher ? { fetcher: props.fetcher } : {})
      .then((message) => error.set(message))
      .finally(() => { busy = false; pending.set(false); });
  };
  const button = (label: string, posture: AndroidFoldPosture, glyph: string) => {
    const pressed = view().fold?.posture === posture;
    const disabled = pending() || !props.enabled();
    return (
      <View role="button" accessibilityLabel={label} tooltip={label} accessibilityState={{ pressed, ...(disabled ? { disabled: true } : {}) }} disabled={disabled}
        onPress={() => { if (!disabled) change(posture); }}
        class={`size-8 items-center justify-center rounded-full ${disabled ? "opacity-50" : pressed ? "bg-secondary" : "hover:bg-accent"}`}>
        <DIcon name={glyph} size={28} />
      </View>
    );
  };
  return (
    <>
      {view().fold?.supported && props.visible() ? (
        <View accessibilityLabel="Android fold controls" class="items-center gap-2">
          <View class="shrink-0 items-center gap-1 rounded-full border border-border-60 bg-background p-1 shadow-sm">
            {button("Fold device", "closed", "duo-closed")}
            {button("Unfold device", "opened", "duo-open")}
          </View>
          {error() ? <View role="alert" accessibilityLabel={error()!} tooltip={error()!}><Text class="text-xs text-destructive">!</Text></View> : null}
        </View>
      ) : null}
    </>
  );
}
