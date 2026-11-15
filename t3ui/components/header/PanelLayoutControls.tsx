// PanelLayoutControls.tsx: the thread details, terminal drawer and right panel
// toggles (and the maximize toggle while the panel is open), in the web's order
// with its labels, tooltips and unavailable states.
import { platform, Text, View } from "nsh";
import type { ViewRef } from "nsh";
import { rightPanelTrigger } from "../focusHandBack";
import { Tooltip } from "nsh/base";
import { enterStyle } from "../motion/Motion";
import { panelAnimationMs, panelFade } from "../motion/panelMotion";
import { HIcon } from "./HeaderIcons";
import { shortcutLabelForCommand, withShortcut } from "./headerLogic";
import {
  currentPanelKey, detailsPanelKey, panelStateFor, surfaceAvailability, toggleDetailsAction, toggleMaximizedAction, toggleRightPanelAction,
  toggleTerminalAction,
} from "../rightPanel/panelState";

const mac = () => platform.os === "macos" || platform.os === "ios";

function Tip(props: { text: string }) {
  return (
    <Tooltip class="rounded-md border border-border bg-popover px-2 py-1">
      <Text class="text-xs text-popover-foreground">{props.text}</Text>
    </Tooltip>
  );
}

/** A `Toggle variant="ghost" size="sm"`: 28pt, rounded-lg, accent fill while pressed. */
export function PanelToggle(props: {
  icon: string;
  label: string;
  tooltip: string;
  pressed: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** The toggle's view, for a region that hands the focus back to it on collapse (focusHandBack.ts). */
  viewRef?: (node: ViewRef | null) => void;
}) {
  return (
    <View
      ref={props.viewRef}
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ pressed: props.pressed, disabled: props.disabled === true }}
      disabled={props.disabled}
      tooltip={<Tip text={props.tooltip} />}
      desktop={{ windowDrag: false }}
      onPress={props.onPress}
      class={`size-7 shrink-0 items-center justify-center rounded-lg ${props.disabled ? "opacity-64" : props.pressed ? "bg-accent" : "hover:bg-accent"}`}
    >
      <HIcon name={props.icon} size={16} />
    </View>
  );
}

export function RightPanelMaximizeControl() {
  const maximized = () => panelStateFor(currentPanelKey()).maximized;
  const label = () => (maximized() ? "Restore panel size" : "Maximize panel");
  // The control mounts with the right panel and fades in over the panel animation setting (default 0: at once), PanelLayoutControls.tsx:198.
  return (
    <View style={enterStyle(panelFade(panelAnimationMs()))}>
      <PanelToggle
        icon={maximized() ? "minimize-2" : "maximize-2"}
        label={label()}
        tooltip={label()}
        pressed={maximized()}
        onPress={toggleMaximizedAction}
      />
    </View>
  );
}

/** Which toggles to draw. With the inline right panel open the web splits them (ChatView.tsx
 * inlineRightPanelOwnsTitleBar): the thread header keeps the details toggle (ThreadPanelHeaderControl) and the
 * panel's top bar carries the terminal and panel toggles. */
export function PanelLayoutControls(props: { show?: "all" | "details" | "rest" } = {}) {
  const show = () => props.show ?? "all";
  const state = () => panelStateFor(currentPanelKey());
  const available = () => surfaceAvailability();
  const terminalLabel = () => shortcutLabelForCommand("terminal.toggle", mac());
  const rightPanelLabel = () => shortcutLabelForCommand("rightPanel.toggle", mac());
  const detailsLabel = () => shortcutLabelForCommand("threadPanel.toggle", mac());
  return (
    <View class="h-full shrink-0 flex-row items-center gap-1" testID="Panel layout controls" desktop={{ windowDrag: false }}>
      {show() !== "rest" ? <PanelToggle
        icon="square-menu"
        label="Toggle thread details panel"
        tooltip={withShortcut("Toggle thread details", detailsLabel())}
        pressed={panelStateFor(detailsPanelKey()).detailsOpen}
        onPress={toggleDetailsAction}
      /> : null}
      {show() !== "details" ? <PanelToggle
        icon="panel-bottom"
        label="Toggle terminal drawer"
        tooltip={available().terminal ? withShortcut("Toggle terminal drawer", terminalLabel()) : "Terminal drawer is unavailable"}
        pressed={state().terminalOpen}
        disabled={!available().terminal}
        onPress={toggleTerminalAction}
      /> : null}
      {show() !== "details" ? <PanelToggle
        icon="panel-right"
        label="Toggle right panel"
        tooltip={available().rightPanel ? withShortcut("Toggle right panel", rightPanelLabel()) : "Right panel is unavailable"}
        pressed={state().open}
        disabled={!available().rightPanel}
        onPress={toggleRightPanelAction}
        viewRef={rightPanelTrigger.ref}
      /> : null}
    </View>
  );
}
