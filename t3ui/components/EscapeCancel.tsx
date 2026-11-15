// Escape for app modals, the way the runtime gives it to overlays.
//
// The runtime's key table is JS's `keymap.bind` bindings first, then the views' own, then one Escape binding
// (`when: always`) for the overlays that listen to `onCancel` (nsh-core core/components.rs `keymap()`, core/overlay.rs
// `overlay_key_binding`). The newest binding wins, and a focused RichEditor (the composer) binds every key as a view
// (nsh-base rich_editor/view/controller.rs, `key_table()` with `When::Always`). So while the composer holds the keyboard
// no `keymap.bind("escape")` of a page or dialog ever fires, `when: "always"` or not. An overlay's `onCancel` does:
// it comes after the views, and it goes to the top shown overlay only, so a dialog opened over Settings closes first
// (the reference's precedence: the newest popup takes Escape).
//
// Render <EscapeCancel> while the modal is up; it draws nothing.
import { Overlay, signal, View } from "nsh";

// How many prompt editors (RichEditor views) hold the keyboard. While one does, the JS Escape bindings of the page
// under it are dead, so a page that otherwise relies on them (and on the inner ones it holds) takes Escape this way.
const editorFocusCount = signal(0);
export function noteEditorFocus(focused: boolean) {
  editorFocusCount.update((n) => Math.max(0, n + (focused ? 1 : -1)));
}
export const editorHoldsKeyboard = () => editorFocusCount() > 0;

export function EscapeCancel(props: { onCancel: () => void }) {
  return (
    // A zero-size, click-through box: an unsized overlay fills its root, and a press on it reached a dialog as a press
    // outside its card, which closed the dialog (seen on the scheduled-task editor).
    <Overlay onCancel={() => props.onCancel()} style={{ left: 0, top: 0, width: 0, height: 0, pointerEvents: "none" }}>
      <View style={{ width: 0, height: 0, pointerEvents: "none" }} />
    </Overlay>
  );
}
