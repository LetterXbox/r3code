// The default-ref confirmation of GitActionsControl.tsx: Push, Create PR and their commit variants ask before they
// run on the default ref. Abort leaves; Continue runs it there; "Check out feature branch & continue" runs it on a
// new branch (the server names it from the uncommitted changes, so it needs some).
import { Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { DIALOG_MS } from "../motion/motionTokens";
import { resolveDefaultBranchActionDialogCopy, resolveFeatureBranchUnavailableReason, type DefaultBranchGate } from "./gitActionLogic";
import { DialogCloseButton } from "../DialogCloseButton";

const buttonClass = "min-h-8 max-w-full items-center justify-center rounded-lg px-3 py-1.5";

export function DefaultBranchDialog(props: {
  /** The action waiting for an answer; null closes the dialog. */
  pending: () => DefaultBranchGate | null;
  terminology: () => { shortLabel: string; singular: string };
  hasWorkingTreeChanges: () => boolean;
  /** `canWriteSourceControl`: Continue needs it. */
  canWrite: () => boolean;
  /** `canChangeThreadBranch`: the feature branch run needs it too. */
  canChangeBranch: () => boolean;
  onAbort: () => void;
  onContinue: (featureBranch: boolean) => void;
}) {
  useOverlayOpen(() => props.pending() !== null, "default branch dialog", DIALOG_MS);
  const copy = () => {
    const gate = props.pending();
    return gate ? resolveDefaultBranchActionDialogCopy({ action: gate.action, branchName: gate.branchName, includesCommit: gate.includesCommit, terminology: props.terminology() }) : null;
  };
  const unavailable = () => {
    const gate = props.pending();
    return gate ? resolveFeatureBranchUnavailableReason({ branchName: gate.branchName, hasWorkingTreeChanges: props.hasWorkingTreeChanges() }) : null;
  };
  const featureDisabled = () => !props.canChangeBranch() || unavailable() !== null;
  return (
    <Dialog
      open={props.pending() !== null}
      animation="fade"
      onOpenChange={({ open }) => { if (!open) props.onAbort(); }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 576, maxWidth: "92%" }, dialogPopupMotion(() => props.pending() !== null)]}
    >
      <View class="relative gap-4 rounded-2xl border border-border bg-background p-6" role="group" accessibilityLabel={copy()?.title ?? "Run action on default branch?"} onPress={keepPressInDialog}>
        <DialogCloseButton onClose={props.onAbort} />
        <View class="gap-1.5">
          <Text class="text-lg font-semibold text-foreground">{copy()?.title ?? "Run action on default branch?"}</Text>
          <Text class="text-sm text-muted-foreground">{copy()?.description ?? ""}</Text>
          {unavailable() ? <Text class="text-xs text-muted-foreground">{unavailable()}</Text> : null}
        </View>
        <View class="flex-row flex-wrap items-center justify-end gap-2">
          <View role="button" accessibilityLabel="Abort" onPress={props.onAbort} class={`${buttonClass} mr-auto border border-input hover:bg-accent`}><Text class="text-sm text-foreground">Abort</Text></View>
          <View role="button" accessibilityLabel={copy()?.continueLabel ?? "Continue"} disabled={!props.canWrite()} onPress={() => props.onContinue(false)} class={`${buttonClass} border border-input ${props.canWrite() ? "hover:bg-accent" : "opacity-64"}`}>
            <Text class="text-sm text-foreground">{copy()?.continueLabel ?? "Continue"}</Text>
          </View>
          <View role="button" accessibilityLabel="Check out feature branch & continue" disabled={featureDisabled()} onPress={() => props.onContinue(true)} class={`${buttonClass} bg-primary ${featureDisabled() ? "opacity-64" : ""}`}>
            <Text class="text-sm font-medium text-primary-foreground">Check out feature branch & continue</Text>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
