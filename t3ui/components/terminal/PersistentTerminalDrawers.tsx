// Keeps each visited thread's terminal drawer mounted (hidden when it is not the open thread's, or while a dialog
// suspends it) instead of unmounting it. Unmounting destroyed the WebView, so every thread switch, preview or
// rewind dialog reloaded the renderer, flashed it blank and dropped the keyboard focus (the reference's
// PersistentThreadTerminals.tsx keeps the views alive for the same reason).
import { effect, signal, untracked, View } from "nsh";
import { editorHoldsKeyboard } from "../EscapeCancel";
import { releasePromptKeyboard } from "../composer/editor/PromptEditor";
import { createPresence } from "../motion/Motion";
import { panelAnimationMs } from "../motion/panelMotion";
import { overlayOpen, webViewsUnderSurface } from "../rightPanel/nativeOcclusion";
import { bindTerminalTyping, drawerTypingWanted } from "./terminalTyping";
import { terminalFocused } from "./terminalCommands";
import { TerminalDrawer } from "./TerminalDrawer";
import { drawerShown, nextMountedDrawers, type DrawerTarget } from "./persistentDrawers";
import { groupHoldsWebKeyboard, PARKED_WEBVIEW_STYLE, releaseWebKeyboard } from "./webKeyboard";

export function PersistentTerminalDrawers(props: {
  /** The open thread's drawer when it is open, else null. */
  current: () => DrawerTarget | null;
  /** True while a dialog (an attachment preview, the rewind confirmation) must hide every drawer. */
  suspended?: () => boolean;
}) {
  const mounted = signal<readonly DrawerTarget[]>([]);
  effect(() => {
    const current = props.current();
    mounted.update((all) => nextMountedDrawers(all, current));
  });
  // Opening the drawer hands it the keyboard (the reference focuses the terminal): the composer lets go, and the keys
  // the app receives go to the shell while the web view itself cannot be focused (terminalTyping.ts). Closing the drawer,
  // or the composer taking the keyboard back (a click into it), ends that.
  let openKey: string | null = untracked(props.current)?.key ?? null;
  effect(() => {
    const key = props.current()?.key ?? null;
    if (key === openKey) return;
    const left = openKey;
    openKey = key;
    // Closing the drawer gives the keyboard back to the app: its terminal page is blurred, so its WKWebView (still the
    // window's first responder; nothing can move that) passes the keys on, and the drawer stays mounted with that
    // WebView parked as a point (webKeyboard.ts). Hiding or removing it took every key with it (VERIFY3 6c).
    if (left !== null) releaseWebKeyboard();
    if (key === null) { drawerTypingWanted.set(false); return; }
    drawerTypingWanted.set(true);
    void releasePromptKeyboard();
  });
  // The composer taking the keyboard (a click into it), or a menu, palette or dialog opening, takes typing from the terminal.
  effect(() => { if (editorHoldsKeyboard()) { drawerTypingWanted.set(false); releaseWebKeyboard(); } });
  // `overlayOpen`, not `nativeViewOccluded`: a host that draws WebViews under the app's surface hides nothing, but an open
  // menu or dialog still takes the typing from the terminal.
  effect(() => { if (overlayOpen()) releaseWebKeyboard(); });
  effect(() => {
    if (!drawerTypingWanted() || props.current() === null || (props.suspended?.() ?? false) || overlayOpen()) return;
    return bindTerminalTyping();
  });
  // A dialog hides the drawer only where WebViews are drawn above it. Under the app's surface the dialog draws over the
  // live terminal, and hiding it would only make the chat column jump.
  const hiddenByDialog = () => (props.suspended?.() ?? false) && !webViewsUnderSurface();
  // Persistent host view sits in the chat column at height 0 when closed so LayoutAnimation smoothly
  // interpolates height 0 <-> drawer height on open and close in lockstep with the chat transcript.
  return (
    <View class="w-full shrink-0 overflow-hidden">
      <Each of={mounted()} key={(target) => target.key}>
        {(target) => {
          const shown = () => drawerShown(target().key, props.current(), hiddenByDialog());
          const presence = createPresence(shown, panelAnimationMs);
          return (
            <View
              class={shown() ? "w-full shrink-0 overflow-hidden" : presence.closing() ? "w-full shrink-0 overflow-hidden" : groupHoldsWebKeyboard(target().key) ? "overflow-hidden" : "hidden"}
              style={shown() ? undefined : presence.closing() ? { height: 0, pointerEvents: "none" as const } : groupHoldsWebKeyboard(target().key) ? PARKED_WEBVIEW_STYLE : undefined}
              accessibilityLabel={`Terminal drawer host ${target().key}`}
            >
              <TerminalDrawer stateKey={target().key} threadId={target().threadId} cwd={target().cwd} shown={shown} />
            </View>
          );
        }}
      </Each>
    </View>
  );
}
