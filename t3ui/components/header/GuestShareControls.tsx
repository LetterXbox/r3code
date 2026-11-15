// GuestShareControls.tsx: the "Share with guest" dialog and a guest's waiting messages. The header's status and
// "Stop sharing" live in ThreadHeader (GuestShareIndicator). Mount GuestShareDialogHost once next to ConfirmDialogHost
// (App.tsx), and GuestPendingMessages in the timeline footer under the thread status line.
import { Clipboard, cleanup, effect, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { backendStatus, openThread, requestBackend } from "../../store";
import { chatWidthClass } from "../thread/layout";
import { showToast } from "../toast";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { closeGuestShareDialog, createGuestShare, guestPendingLabel, guestShareCreateNote, guestShareDialogThreadId, resolveGuestMessage, GUEST_SHARE_DIALOG_DESCRIPTION, GUEST_SHARE_DIALOG_TITLE, type GuestShareCreateState } from "./guestShare";
import { pendingGuestMessages, type GuestMessage } from "./threadRelations";
import { HIcon } from "./HeaderIcons";
import { Thumbnail } from "../thread/MessageMedia";
import { readAttachment } from "../thread/readAttachment";
import { openAttachmentAction } from "../rightPanel/panelState";
import { formatAttachmentSize } from "../composer/attachmentIntake";
import { allThreads } from "../../store";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { DIALOG_MS } from "../motion/motionTokens";
import { DialogCloseButton } from "../DialogCloseButton";

export function GuestShareDialogHost() {
  const open = () => guestShareDialogThreadId() !== null;
  const state = signal<GuestShareCreateState>({ status: "idle" });
  const copied = signal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(copiedTimer));
  useOverlayOpen(open, "guest share dialog", DIALOG_MS);
  // Each opening starts over.
  effect(() => { if (open()) { state.set({ status: "idle" }); copied.set(false); } });
  const share = () => allThreads().find((thread) => thread.id === guestShareDialogThreadId())?.relations?.guestShare ?? null;
  const creating = () => state().status === "creating";
  const close = () => { if (!creating()) closeGuestShareDialog(); };

  async function create() {
    const id = guestShareDialogThreadId();
    if (!id || creating()) return;
    state.set({ status: "creating" });
    try { state.set({ status: "created", url: await createGuestShare(id, requestBackend) }); }
    catch (cause) { state.set({ status: "failed", message: cause instanceof Error && cause.message ? cause.message : "Could not create a guest link." }); }
  }
  function copy(url: string) {
    void Clipboard.writeText(url).then(() => {
      copied.set(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => copied.set(false), 2000);
    }, () => showToast({ type: "error", title: "Failed to copy guest link" }));
  }
  const created = () => { const value = state(); return value.status === "created" ? value : null; };
  const failed = () => { const value = state(); return value.status === "failed" ? value : null; };

  return (
    <Dialog open={open()} animation="fade" testID="guest-share-dialog" onOpenChange={(event) => { if (!event.open) close(); }} backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 512, maxWidth: "92%", maxHeight: "92%" }, dialogPopupMotion(open)]}>
      <View class="relative overflow-hidden rounded-2xl border border-border bg-background" accessibilityLabel={GUEST_SHARE_DIALOG_TITLE} onPress={keepPressInDialog}>
        <DialogCloseButton onClose={close} />
        <View class="gap-2 p-6">
          <Text class="text-xl font-semibold leading-snug text-popover-foreground" role="header">{GUEST_SHARE_DIALOG_TITLE}</Text>
          <Text class="text-sm text-muted-foreground">{GUEST_SHARE_DIALOG_DESCRIPTION}</Text>
        </View>
        <View class="gap-2 px-6 pb-6">
          {created() ? (
            <View class="flex-row items-center gap-2">
              <View class="h-8 min-w-0 flex-1 justify-center rounded-lg border border-input px-3" accessibilityLabel="Guest link">
                <View selectable><Text class="truncate text-sm text-foreground">{created()?.url}</Text></View>
              </View>
              <View role="button" accessibilityLabel={copied() ? "Copied" : "Copy"} onPress={() => copy(created()!.url)} class="h-8 flex-row items-center gap-1.5 rounded-lg border border-input bg-popover px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out">
                <HIcon name={copied() ? "check" : "files"} size={14} />
                <Text class="text-sm font-medium text-foreground">{copied() ? "Copied" : "Copy"}</Text>
              </View>
            </View>
          ) : (
            <Text class="text-sm text-muted-foreground">{guestShareCreateNote(share() !== null)}</Text>
          )}
          {failed() ? <Text class="text-xs text-error-foreground" role="alert">{failed()?.message}</Text> : null}
        </View>
        <View class="flex-row justify-end gap-2 border-t border-border bg-muted-72 px-6 py-4">
          {created() ? (
            <View role="button" accessibilityLabel="Done" onPress={closeGuestShareDialog} class="h-8 items-center justify-center rounded-lg bg-primary px-3 active:scale-[0.97] transition-transform duration-150 ease-in-out">
              <Text class="text-sm font-medium text-primary-foreground">Done</Text>
            </View>
          ) : (
            <>
              <View role="button" accessibilityLabel="Cancel" disabled={creating()} onPress={close} class={`h-8 items-center justify-center rounded-lg border border-input bg-popover px-3 hover:bg-accent-50 ${creating() ? "opacity-64" : ""}`}>
                <Text class="text-sm font-medium text-foreground">Cancel</Text>
              </View>
              <View role="button" accessibilityLabel={creating() ? "Creating..." : "Create link"} disabled={creating() || backendStatus() !== "connected"} onPress={() => void create()} class={`h-8 items-center justify-center rounded-lg bg-primary px-3 ${creating() ? "opacity-64" : ""}`}>
                <Text class="text-sm font-medium text-primary-foreground">{creating() ? "Creating..." : "Create link"}</Text>
              </View>
            </>
          )}
        </View>
      </View>
    </Dialog>
  );
}

/**
 * GuestMessageAttachments: a guest message's files drawn like a sent message's: image thumbnails in a two-column grid (pressing one
 * opens it in the viewer), then file rows with their size (pressing one previews it). The bytes come through the signed-asset route.
 */
function GuestAttachments(props: { attachments: () => GuestMessage["attachments"] }) {
  const images = () => props.attachments().filter((file) => file.type === "image");
  const files = () => props.attachments().filter((file) => file.type !== "image");
  const open = (file: GuestMessage["attachments"][number]) => openAttachmentAction({ id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes ?? 0 });
  return (
    <>
      {images().length ? (
        <View class="w-[210px] flex-row flex-wrap gap-2" accessibilityLabel="Guest image attachments">
          <Each of={images()} key={(file) => file.id}>
            {(file) => (
              <View class="w-[101px] overflow-hidden rounded-lg border border-border bg-background" style={{ aspectRatio: 4 / 3 }}>
                <Thumbnail attachment={{ type: "image", id: file().id, name: file().name, mimeType: file().mimeType, sizeBytes: file().sizeBytes ?? 0 } as never} load={readAttachment} class="size-full" onOpen={() => open(file())} />
              </View>
            )}
          </Each>
        </View>
      ) : null}
      <Each of={files()} key={(file) => file.id}>
        {(file) => (
          <View role="button" accessibilityLabel={`Preview ${file().name}`} onPress={() => open(file())} class="min-w-0 flex-row items-center gap-2 py-1">
            <HIcon name="file" size={14} />
            <Text class="min-w-0 truncate text-sm text-foreground">{file().name}</Text>
            {file().sizeBytes ? <Text class="shrink-0 text-xs text-muted-foreground">{formatAttachmentSize(file().sizeBytes!)}</Text> : null}
          </View>
        )}
      </Each>
    </>
  );
}

/**
 * A guest's messages wait at the end of the timeline until the owner sends or dismisses each one. A pending bubble has
 * a dashed guest-coloured edge and no fill; the owner sees Dismiss and Send under it.
 */
export function GuestPendingMessages(props: { messages?: () => GuestMessage[]; guestName?: () => string | null; onResolve?: (id: string, decision: "send" | "dismiss") => Promise<unknown> } = {}) {
  const busy = signal<string[]>([]);
  const share = () => openThread()?.relations?.guestShare ?? null;
  const pending = () => props.messages ? props.messages() : pendingGuestMessages(share());
  const name = () => (props.guestName ? props.guestName() : share()?.guestName) ?? "Guest";
  async function resolve(id: string, decision: "send" | "dismiss") {
    const threadId = openThread()?.id;
    if (busy().includes(id)) return;
    busy.update((ids) => [...ids, id]);
    try {
      if (props.onResolve) await props.onResolve(id, decision);
      else if (threadId) await resolveGuestMessage({ threadId, guestMessageId: id, decision }, requestBackend);
    } catch (cause) {
      showToast({ type: "error", title: decision === "send" ? "Failed to send guest message" : "Failed to dismiss guest message", description: cause instanceof Error ? cause.message : undefined });
    } finally { busy.update((ids) => ids.filter((item) => item !== id)); }
  }
  return pending().length === 0 ? null : (
    <View class="shrink-0 px-3">
      <View class={`mx-auto w-full ${chatWidthClass()} gap-4 pb-4`} accessibilityLabel={guestPendingLabel(pending().length)} role="list">
        <Each of={pending()} key={(message) => message.id}>
          {(message) => (
            <View class="items-end gap-1">
              <Text class="mr-1 text-2xs text-guest-foreground">{`${name()} (guest)`}</Text>
              <View class="min-w-0 max-w-[80%] gap-2 rounded-2xl border border-dashed border-guest p-3">
                <GuestAttachments attachments={() => message().attachments} />
                {message().text ? <View selectable><Text class="text-sm leading-relaxed text-foreground">{message().text}</Text></View> : null}
              </View>
              <View class="flex-row items-center gap-1 pr-1">
                <View role="button" accessibilityLabel={`Dismiss message from ${name()}`} disabled={busy().includes(message().id)} onPress={() => void resolve(message().id, "dismiss")} class={`h-6 items-center justify-center rounded-md px-2 hover:bg-accent ${busy().includes(message().id) ? "opacity-64" : ""}`}>
                  <Text class="text-xs font-medium text-muted-foreground">Dismiss</Text>
                </View>
                <View role="button" accessibilityLabel={`Send message from ${name()}`} disabled={busy().includes(message().id)} onPress={() => void resolve(message().id, "send")} class={`h-6 items-center justify-center rounded-md bg-primary px-2 ${busy().includes(message().id) ? "opacity-64" : ""}`}>
                  <Text class="text-xs font-medium text-primary-foreground">Send</Text>
                </View>
              </View>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}
