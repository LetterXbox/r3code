import { keymap, Text, View } from "nsh";
import { dialogBackdropStyle } from "../dialogSurface";

/** RevertConfirmHost: the "Edit from here?" alert, with the web's own copy and three actions. */
export function RewindConfirm(props: { onCancel: () => void; onConfirm: (restoreFiles: boolean) => void }) {
  keymap.bind("escape", props.onCancel, { when: "always" });
  return (
    <View class="absolute inset-0 items-center justify-center p-8" style={dialogBackdropStyle()} role="group">
      <View class="w-full max-w-[460px] gap-4 rounded-2xl border border-border bg-background p-6">
        <View class="w-full shrink-0 gap-2">
          <Text class="text-lg font-semibold text-foreground" role="header">Edit from here?</Text>
          <Text class="text-sm text-muted-foreground">
            Rewind chat to before this message. Your prompt and attachments return to the composer. “Revert files too” also undoes your own edits.
          </Text>
        </View>
        <View class="shrink-0 flex-row flex-wrap justify-end gap-2">
          <View class="h-8 items-center justify-center rounded-lg border border-input px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={props.onCancel} accessibilityLabel="Cancel" role="button">
            <Text class="text-sm text-foreground">Cancel</Text>
          </View>
          <View class="h-8 items-center justify-center rounded-lg border border-input px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={() => props.onConfirm(true)} accessibilityLabel="Revert files too" role="button">
            <Text class="text-sm text-destructive-foreground">Revert files too</Text>
          </View>
          <View class="h-8 items-center justify-center rounded-lg bg-primary px-3 active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={() => props.onConfirm(false)} accessibilityLabel="Revert and keep changes" role="button">
            <Text class="text-sm text-primary-foreground">Revert and keep changes</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
