// ComposerAttachmentStrip.tsx ComposerFilePreviewDialog: a draft file opened large over the app, in the attachment viewer its type
// calls for, headed "Draft", with "Remove from draft" and "Close". A file still on this computer reads from its bytes; one that only
// lives on the server (a restored draft) reads through the signed-asset route like any sent attachment.
import { effect, keymap, View } from "nsh";
import { Dialog } from "nsh/base";
import { readAttachment } from "../thread/readAttachment";
import { AttachmentFileView, type AttachmentFile } from "../files/AttachmentFileView";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { dialogBackdropStyle, keepPressInDialog } from "../dialogSurface";
import { EscapeCancel } from "../EscapeCancel";
import { DIALOG_MS } from "../motion/motionTokens";

export interface ComposerPreviewFile extends AttachmentFile {
  /** The draft's own bytes, when it still has them. */
  file?: File;
}

export function ComposerFilePreviewDialog(props: { file: () => ComposerPreviewFile | null; onRemove: (id: string) => void; onClose: () => void }) {
  const open = () => props.file() !== null;
  useOverlayOpen(open, "composer file preview", DIALOG_MS);
  effect(() => {
    if (!open()) return;
    return keymap.bind({ escape: props.onClose }, { when: "always" });
  });
  return (
    <Dialog
      open={open()}
      animation="fade"
      testID="composer-file-preview"
      onOpenChange={({ open: next }) => { if (!next) props.onClose(); }}
      backdropStyle={dialogBackdropStyle()}
      style={{ margin: "auto", width: 896, maxWidth: "92%", height: "85%", maxHeight: 832 }}
    >
      {open() ? <EscapeCancel onCancel={props.onClose} /> : null}
      <View class="size-full overflow-hidden rounded-2xl border border-border bg-background" onPress={keepPressInDialog} accessibilityLabel="File preview">
        {props.file() ? (
          <AttachmentFileView
            attachment={{ id: props.file()!.id, name: props.file()!.name, mimeType: props.file()!.mimeType, sizeBytes: props.file()!.sizeBytes }}
            load={(id, options) => { const bytes = props.file()?.file; return bytes ? Promise.resolve(bytes) : readAttachment(id, options); }}
            origin="Draft"
            onRemove={() => { const current = props.file(); if (current) { props.onRemove(current.id); props.onClose(); } }}
            onClose={props.onClose}
          />
        ) : null}
      </View>
    </Dialog>
  );
}
