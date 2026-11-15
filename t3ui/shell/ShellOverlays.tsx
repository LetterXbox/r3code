// What the app shell mounts last, above every page, dialog host and the palette: the shared confirmation dialog, the
// toast stack and the quit-hold hint. Each registers with the WebView occlusion registry while it shows.
import { ConfirmDialogHost } from "../components/toast/ConfirmDialogHost";
import { AnchoredToastHost } from "../components/toast/AnchoredToastHost";
import { ToastHost } from "../components/toast/ToastHost";
import { GuestShareDialogHost } from "../components/header/GuestShareControls";
import { ExpandedMediaHost } from "../components/thread/markdown/ExpandedMedia";
import { QuitHoldOverlay } from "./QuitHoldOverlay";

export function ShellOverlays() {
  return (
    <>
      <GuestShareDialogHost />
      <ExpandedMediaHost />
      <ConfirmDialogHost />
      <ToastHost />
      <AnchoredToastHost />
      <QuitHoldOverlay />
    </>
  );
}
