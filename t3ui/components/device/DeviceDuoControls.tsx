// DeviceDuoControls.tsx (+ client-runtime duoControl.ts duoFoldState / duoHoldOrientation): the iPhone Duo's fold shape
// (Closed / Book or Laptop / Open) and stance (Laptop stand / Tent stand) in the controls rail, shown with the 3D Duo.
// Commands go to the 3D page's stream client (deviceViewer.ts); its control state comes back from there.
import { effect, signal, Text, View } from "nsh";
import { DIcon } from "./DeviceIcons";

export type DuoPose = "closed" | "book" | "open" | "laptop" | "tent";
export type DuoOrientation = "portrait" | "landscape_left" | "portrait_upside_down" | "landscape_right";
export type DuoCommand =
  | { control: "angle"; value: number }
  | { control: "pose"; value: DuoPose }
  | { control: "table"; value: boolean }
  | { control: "physical"; value: "faceup" | "facedown" }
  | { control: "orientation"; value: DuoOrientation };
export interface DuoControlState { pending: boolean; requested: DuoCommand | null; error: string | null }
export interface DuoScreen { orientation: string; screenId?: number; hingeAngle?: number; hingePose?: string | null }

export function duoScreenSettled(screen: Pick<DuoScreen, "screenId" | "hingeAngle">) {
  const angle = screen.hingeAngle ?? (screen.screenId === 1 ? 0 : 180);
  return (screen.screenId === 1) === (angle === 0);
}

/** The inner panel is mounted a quarter turn from the cover, so its landscape orientation means a vertical phone. */
export function duoFoldState(screen: DuoScreen) {
  const angle = screen.hingeAngle ?? (screen.screenId === 1 ? 0 : 180);
  const landscape = screen.orientation.startsWith("landscape");
  return {
    fold: angle === 0 ? "closed" : angle === 180 ? "open" : "half",
    stand: screen.hingePose === "laptop" || screen.hingePose === "tent",
    phoneVertical: screen.screenId === 1 ? !landscape : landscape,
    settled: duoScreenSettled(screen),
  } as const;
}

export function duoHoldOrientation(vertical: boolean, screenId: number | undefined): DuoOrientation {
  if (screenId === 1) return vertical ? "portrait" : "landscape_left";
  return vertical ? "landscape_left" : "portrait_upside_down";
}

const FOLDS = [{ id: "closed", angle: 0 }, { id: "half", angle: 90 }, { id: "open", angle: 180 }] as const;
const STANDS = [{ id: "laptop", label: "Laptop stand" }, { id: "tent", label: "Tent stand" }] as const;

export function DeviceDuoControls(props: { screen: () => DuoScreen; state: () => DuoControlState; enabled: () => boolean; onCommand: (command: DuoCommand) => void }) {
  // The orientation the phone was last held in while settled, and the one a stand started from.
  const settledVertical = signal(duoFoldState(props.screen()).phoneVertical);
  const standVertical = signal(settledVertical());
  effect(() => { const state = duoFoldState(props.screen()); if (state.settled) settledVertical.set(state.phoneVertical); });
  const view = () => {
    const state = duoFoldState(props.screen());
    const phoneVertical = state.stand ? standVertical() : settledVertical();
    // Only one command can wait; defer fold controls until stand rotation and queued commands settle.
    const foldWaits = props.state().pending && (state.stand || props.state().requested?.control === "pose");
    return { ...state, phoneVertical, foldWaits };
  };
  const button = (label: string, pressed: boolean, onPress: () => void, glyph: string, waits = false) => {
    const disabled = !props.enabled() || waits;
    return (
      <View role="button" accessibilityLabel={label} tooltip={label} accessibilityState={{ pressed, ...(disabled ? { disabled: true } : {}) }} disabled={disabled}
        onPress={() => { if (!disabled) onPress(); }}
        class={`size-8 items-center justify-center rounded-full ${disabled ? "opacity-50" : pressed ? "bg-secondary" : "hover:bg-accent"}`}>
        <DIcon name={glyph} size={28} />
      </View>
    );
  };
  const group = "shrink-0 items-center gap-1 rounded-full border border-border-60 bg-background p-1 shadow-sm";
  return (
    <View accessibilityLabel="iPhone Duo stands" class="items-center gap-2">
      <View accessibilityLabel="Fold shape" class={group}>
        {FOLDS.map(({ id, angle }) => {
          const v = view();
          const label = id === "closed" ? "Closed" : id === "open" ? "Open" : v.phoneVertical ? "Book" : "Laptop";
          // The web rotates the glyph a quarter turn when the phone is held sideways; the port's icons do not rotate.
          return button(label, !v.stand && v.fold === id, () => {
            if (v.stand) props.onCommand({ control: "orientation", value: duoHoldOrientation(standVertical(), props.screen().screenId) });
            props.onCommand({ control: "angle", value: angle });
          }, id === "half" ? "duo-book" : `duo-${id}`, v.foldWaits);
        })}
      </View>
      <View accessibilityLabel="Device stance" class={group}>
        {STANDS.map(({ id, label }) => button(label, props.screen().hingePose === id, () => {
          if (!view().stand) standVertical.set(settledVertical());
          props.onCommand({ control: "pose", value: id });
        }, `duo-${id}`))}
      </View>
      {props.state().error ? <View role="alert" accessibilityLabel={props.state().error!} tooltip={props.state().error!}><Text class="text-xs text-destructive">!</Text></View> : null}
    </View>
  );
}
