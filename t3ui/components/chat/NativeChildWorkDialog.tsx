// chat/NativeChildWorkDialog.tsx: the "Subagent work" button on an Antigravity subagent's bar and its read-only dialog
// (what the provider-native children did). `orchestration.getNativeChildWork` is read only while the dialog is open.
import { effect, Image, Scroll, signal, Text, token, untracked, View } from "nsh";
import { Dialog } from "nsh/base";
import { requestBackend } from "../../store";
import { codeTextStyle } from "../../typography";
import { DIALOG_CARD_CLASS, dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import listTree from "./icons/list-tree.svg";
import { readNativeChildWork, stepHeading, type NativeChildWork } from "./nativeChildWork";
import { DialogCloseButton } from "../DialogCloseButton";

type Request = (method: string, payload: unknown) => Promise<unknown>;

export function NativeChildWorkDialog(props: { threadId: () => string; request?: Request }) {
  const request = props.request ?? requestBackend;
  const open = signal(false);
  const children = signal<NativeChildWork[] | undefined>(undefined);
  const error = signal<string | null>(null);
  const pending = signal(false);
  useOverlayOpen(() => open(), "native child work dialog");
  let serial = 0;
  const load = () => {
    const mine = ++serial;
    pending.set(true);
    error.set(null);
    void request("orchestration.getNativeChildWork", { threadId: props.threadId() }).then((value) => {
      if (mine !== serial) return;
      const read = readNativeChildWork(value);
      if (read) children.set(read); else error.set("The server returned an invalid response.");
    }, (cause: unknown) => { if (mine === serial) error.set(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (mine === serial) pending.set(false); });
  };
  effect(() => {
    if (!open()) { serial++; children.set(undefined); error.set(null); pending.set(false); return; }
    untracked(load);
  });
  return (
    <>
      <View role="button" accessibilityLabel="Subagent work" onPress={() => open.set(true)} class="h-8 flex-row items-center justify-center gap-1.5 rounded-lg px-2.5 hover:bg-accent">
        <Image src={listTree} style={{ width: 16, height: 16, tintColor: token("foreground") }} />
        <Text class="text-sm font-medium text-foreground">Subagent work</Text>
      </View>
      <Dialog
        open={open()}
        animation="fade"
        onOpenChange={({ open: next }) => open.set(next)}
        backdropStyle={dialogBackdropStyle()}
        style={[{ margin: "auto", width: 672, maxWidth: "90%", maxHeight: "85%" }, dialogPopupMotion(open)]}
      >
        <View class={`relative ${DIALOG_CARD_CLASS} gap-4 p-6`} onPress={keepPressInDialog}>
          <DialogCloseButton onClose={() => open.set(false)} />
          <View class="gap-1">
            <Text class="text-lg font-semibold text-foreground">Subagent work</Text>
            <Text class="text-sm text-muted-foreground">Read only. These subagents cannot take messages.</Text>
          </View>
          <Scroll style={{ maxHeight: 480 }}>
            <View class="gap-4">
              {error() !== null ? <Text class="text-sm text-destructive-foreground">{error()}</Text>
                : children() === undefined ? <Text class="text-sm text-muted-foreground">Loading…</Text>
                : children()!.length === 0 ? <Text class="text-sm text-muted-foreground">The provider has no record of which subagents this call started.</Text>
                : children()!.map((child) => (
                  <View class="min-w-0 gap-2" accessibilityLabel={child.role || "Subagent"}>
                    <Text class="text-sm font-medium text-foreground">{child.role || "Subagent"}</Text>
                    <Text class="text-sm text-muted-foreground">{child.prompt}</Text>
                    {child.truncated ? <Text class="text-xs text-muted-foreground">Earlier steps are not shown.</Text> : null}
                    {child.steps === null ? <Text class="text-xs text-muted-foreground">No transcript yet.</Text> : (
                      <View class="gap-2 border-l border-border pl-3">
                        {child.steps.map((step) => (
                          <View class="min-w-0 gap-1">
                            <Text class="text-xs font-medium text-muted-foreground">{stepHeading(step)}</Text>
                            {step.toolCalls.length === 0 ? null : <Text class="text-xs text-foreground" style={codeTextStyle()}>{step.toolCalls.map((call) => `${call.name} ${call.input}`).join("\n")}</Text>}
                            {step.text === null ? null : <Text class="text-xs text-foreground" style={codeTextStyle()}>{step.text}</Text>}
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
            </View>
          </Scroll>
          <View class="flex-row justify-end">
            <View role="button" accessibilityLabel="Refresh" onPress={() => { if (!pending()) load(); }} class={`h-8 items-center justify-center rounded-lg border border-input px-3 hover:bg-accent ${pending() ? "opacity-64" : ""}`}>
              <Text class="text-sm font-medium text-foreground">Refresh</Text>
            </View>
          </View>
        </View>
      </Dialog>
    </>
  );
}
