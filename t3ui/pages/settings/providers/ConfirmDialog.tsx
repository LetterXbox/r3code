// ensureLocalApi().dialogs.confirm: a modal that asks before a destructive change. Registered with the WebView
// occlusion registry while open, so it draws above a terminal or preview; Escape and the backdrop cancel it.
import { SettingsDialog } from "../../../components/SettingsDialog";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { ButtonText, PillButton } from "./ui";

export function ConfirmDialog(props: {
  /** The question; a following line (after a newline) is the consequence. */
  message: string; confirmLabel: string; cancelLabel?: string; confirmAccessibilityLabel?: string; testID?: string; destructive?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  useOverlayOpen(true, "confirm dialog");
  const [question, ...rest] = props.message.split("\n");
  return <SettingsDialog open onClose={props.onClose} title={question ?? props.message} description={rest.join(" ") || undefined} width={448} testID={props.testID ?? "Confirm dialog"}
    footer={<>
      <PillButton label={props.cancelLabel ?? "Cancel"} onPress={props.onClose}><ButtonText>Cancel</ButtonText></PillButton>
      <PillButton label={props.confirmAccessibilityLabel ?? props.confirmLabel} variant={props.destructive === false ? "primary" : "outline"} onPress={props.onConfirm}>
        {props.destructive === false ? <ButtonText tone="primary">{props.confirmLabel}</ButtonText> : <ButtonText tone="destructive">{props.confirmLabel}</ButtonText>}</PillButton>
    </>} />;
}
