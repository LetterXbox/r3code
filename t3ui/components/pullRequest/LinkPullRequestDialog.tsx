// LinkPullRequestDialogHost / LinkPullRequestDialog (components/pullRequest/LinkPullRequestDialog.tsx):
// "Link pull request", the URL field, the resolved repository line, the validation message, Cancel / Link.
import { Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { DialogInput as Input } from "../DialogInput";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import {
  closeLinkDialog, linkDialogDirty, linkDialogError, linkDialogPending, linkDialogReference, linkDialogResolved, linkDialogThread,
  linkValidation, setLinkDialogReference, submitLinkDialog,
} from "./linkPullRequestState";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { DIALOG_MS } from "../motion/motionTokens";
import { DialogCloseButton } from "../DialogCloseButton";

export function LinkPullRequestDialogHost() {
  useOverlayOpen(() => linkDialogThread() !== null, "link pull request dialog", DIALOG_MS);
  const resolved = () => linkDialogResolved();
  const validation = () => linkValidation(linkDialogReference(), resolved(), linkDialogDirty()) ?? linkDialogError();
  const disabled = () => linkDialogPending() || resolved() === null || "error" in resolved()!;
  return (
    <Dialog
      open={linkDialogThread() !== null}
      animation="fade"
      onOpenChange={({ open }) => { if (!open) closeLinkDialog(); }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 576, maxWidth: "90%" }, dialogPopupMotion(() => linkDialogThread() !== null)]}
    >
      <View class="relative gap-4 rounded-2xl border border-border bg-background p-6" onPress={keepPressInDialog}>
        <DialogCloseButton onClose={closeLinkDialog} />
        <View class="gap-2">
          <Text class="text-xl font-semibold text-foreground">Link pull request</Text>
          <Text class="text-sm text-muted-foreground">Attach a pull request to this thread by its URL, or by its number for this thread's repository.</Text>
        </View>
        <View class="gap-2">
          <Input
            autoFocus
            accessibilityLabel="Pull request URL or #42"
            placeholder="Pull request URL or #42"
            value={linkDialogReference()}
            onChange={(event) => setLinkDialogReference(event.value)}
            onSubmit={() => void submitLinkDialog()}
            class="h-8 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          />
          {(() => {
            const value = resolved();
            return value !== null && "link" in value
              ? <Text class="truncate text-xs text-muted-foreground">{`${value.link.host}/${value.link.repository} #${value.link.number}`}</Text>
              : null;
          })()}
          {validation() ? <Text class="text-xs text-destructive">{validation()}</Text> : null}
        </View>
        <View class="flex-row justify-end gap-2">
          <View
            role="button"
            accessibilityLabel="Cancel"
            onPress={closeLinkDialog}
            class="h-8 items-center justify-center rounded-lg border border-input bg-background px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
          >
            <Text class="text-sm font-medium text-foreground">Cancel</Text>
          </View>
          <View
            role="button"
            accessibilityLabel="Link"
            onPress={() => void submitLinkDialog()}
            class={disabled() ? "h-8 items-center justify-center rounded-lg bg-primary px-3 opacity-50 active:scale-[0.97] transition-transform duration-150 ease-in-out" : "h-8 items-center justify-center rounded-lg bg-primary px-3 active:scale-[0.97] transition-transform duration-150 ease-in-out"}
          >
            <Text class="text-sm font-medium text-primary-foreground">{linkDialogPending() ? "Linking..." : "Link"}</Text>
          </View>
        </View>
      </View>
    </Dialog>
  );
}

