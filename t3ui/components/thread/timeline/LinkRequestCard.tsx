import { chatWidthClass } from "../layout";
// chat/LinkRequestCard.tsx: an agent asked the user to link another environment. Answered, it is one work-log line;
// pending, a card with Decline and "Choose machine..." / "Review link..." that opens the two-step dialog (Machine, Access).
// The pairing code lives only in the dialog's field and the `peerLinks.answerRequest` payload.
// Port limits: this client holds one environment connection, so its machine catalog is empty (the picker offers
// "Another address..." and any machine the agent named) and it cannot mint a pairing code on the other machine:
// the user always pastes one.
import { ACCESS_WRITE_SCOPE, scopeAllows } from "../../../backend/sessionScopes";
import { effect, signal, Text, untracked, View } from "nsh";
import { Dialog } from "nsh/base";
import { requestBackend } from "../../../store";
import { DialogInput as Input } from "../../DialogInput";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../../dialogSurface";
import { DIALOG_MS } from "../../motion/motionTokens";
import { useOverlayOpen } from "../../rightPanel/nativeOcclusion";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { DialogCloseButton } from "../../DialogCloseButton";
import {
  accessConfig, LINK_ACCESS_OPTIONS, linkRequestAnswerInput, linkRequestDefaultAccess, linkRequestDisplay, linkRequestFailureMessage,
  linkRequestTargetName, picksMachine, type LinkAccess, type LinkRequestItem,
} from "./linkRequest";

type Send = (method: string, payload: unknown) => Promise<unknown>;
const ANOTHER_ADDRESS = "another-address";

const buttonClass = "h-7 items-center justify-center rounded-lg px-2.5 active:scale-[0.97] transition-transform duration-150 ease-in-out";

export function LinkRequestCard(props: { item: () => LinkRequestItem; send?: Send }) {
  const display = () => linkRequestDisplay(props.item());
  return <View class={`mx-auto w-full min-w-0 ${chatWidthClass()}`}>{display().kind === "pending" ? <PendingLinkRequest item={props.item} send={props.send} /> : (
    <View class="min-h-6 flex-row items-center gap-1.5 px-1 py-0.5" accessibilityLabel="Link request">
      <View class="size-6 items-center justify-center">
        <TimelineIcon name={(() => { const current = display(); return current.kind === "pending-elsewhere" ? "link" : current.kind === "answered" && current.outcome === "linked" ? "check" : current.kind === "answered" && current.outcome === "failed" ? "x" : "minus"; })()} size={14} />
      </View>
      <Text class="min-w-0 flex-1 truncate text-sm text-muted-foreground">{(display() as { label: string }).label}</Text>
    </View>
  )}</View>;
}

function PendingLinkRequest(props: { item: () => LinkRequestItem; send?: Send }) {
  const open = signal(false);
  const declining = signal(false);
  const error = signal<string | null>(null);
  const item = props.item;
  const decline = async () => {
    const input = linkRequestAnswerInput(item(), { type: "decline" });
    if (input === null || declining()) return;
    declining.set(true);
    error.set(null);
    try { await (props.send ?? requestBackend)("peerLinks.answerRequest", input); }
    catch (cause) { error.set(linkRequestFailureMessage(cause)); }
    finally { declining.set(false); }
  };
  return (
    <View class="min-w-0 gap-3 rounded-xl border border-border-60 bg-card p-4" accessibilityLabel="Link request">
      <View class="min-w-0 gap-1">
        <Text class="text-sm font-medium text-foreground">{picksMachine(item()) ? "Link a machine to this environment" : `Link ${linkRequestTargetName(item())} to this environment`}</Text>
        {item().reason.trim() ? <View selectable><Text class="text-sm text-muted-foreground">{item().reason}</Text></View> : null}
        {item().label !== undefined && item().url !== undefined ? <Text class="truncate text-xs text-muted-foreground">{item().url}</Text> : null}
      </View>
      {error() !== null ? <Text class="text-xs text-destructive" role="alert">{error()}</Text> : null}
      {/* LinkRequestCard canAnswer: answering needs access:write (clientRpcPermissions peerLinks.answerRequest). */}
      {!scopeAllows(ACCESS_WRITE_SCOPE) ? <Text class="text-xs text-muted-foreground">Only a session that manages access here can answer this.</Text> : null}
      {scopeAllows(ACCESS_WRITE_SCOPE) ? <View class="min-w-0 flex-row items-center justify-end gap-2">
        <View class={`${buttonClass} hover:bg-accent`} disabled={declining()} onPress={() => void decline()} accessibilityLabel="Decline" role="button">
          <Text class="text-xs text-muted-foreground">Decline</Text>
        </View>
        <View class={`${buttonClass} bg-primary`} disabled={declining()} onPress={() => open.set(true)} accessibilityLabel={picksMachine(item()) ? "Choose machine…" : "Review link…"} role="button">
          <Text class="text-xs font-medium text-primary-foreground">{picksMachine(item()) ? "Choose machine…" : "Review link…"}</Text>
        </View>
      </View> : null}
      <LinkRequestDialog item={item} open={open} send={props.send} />
    </View>
  );
}

function LinkRequestDialog(props: { item: () => LinkRequestItem; open: { (): boolean; set(value: boolean): void }; send?: Send }) {
  const item = props.item;
  const choice = signal<string | null>(null);
  const address = signal(item().url ?? "");
  const access = signal<LinkAccess>(linkRequestDefaultAccess(item()));
  const pairingCode = signal("");
  const step = signal<"machine" | "access">("machine");
  const busy = signal(false);
  const error = signal<string | null>(null);
  const linkedIds = signal<ReadonlySet<string>>(new Set());
  const accessMenuOpen = signal(false);
  useOverlayOpen(() => props.open(), "link request dialog", DIALOG_MS);
  useOverlayOpen(accessMenuOpen, "link access menu");
  let fetchedLinks = false;
  const loadLinks = () => {
    if (fetchedLinks) return;
    fetchedLinks = true;
    void (props.send ?? requestBackend)("peerLinks.list", {}).then((result) => {
      const links = Array.isArray((result as { links?: unknown } | null)?.links) ? (result as { links: Array<Record<string, unknown>> }).links : [];
      linkedIds.set(new Set(links.flatMap((link) => (link.status !== "expired" && typeof link.environmentId === "string" ? [link.environmentId] : []))));
    }).catch(() => undefined);
  };
  effect(() => { if (props.open()) untracked(loadLinks); });
  const pickMachine = () => picksMachine(item());
  // The target: an address the agent gave, the machine it named, or what the user picked.
  const target = () => {
    const current = item();
    if (current.environmentId === undefined && current.url !== undefined) return { kind: "address" as const };
    const chosen = current.environmentId ?? choice();
    if (chosen === null) return { kind: "none" as const };
    if (chosen === ANOTHER_ADDRESS) return { kind: "address" as const };
    return { kind: "machine" as const, environmentId: chosen, label: linkRequestTargetName(current), urls: current.url === undefined ? [] : [current.url], linked: linkedIds().has(chosen) };
  };
  const targetName = () => { const current = target(); return current.kind === "machine" ? current.label : linkRequestTargetName(item()); };
  const needsAddress = () => { const current = target(); return current.kind === "address" || (current.kind === "machine" && current.urls.length === 0); };
  const asksAddress = () => needsAddress() && !(item().url !== undefined && item().environmentId === undefined);
  const useExisting = () => { const current = target(); return current.kind === "machine" && current.linked; };
  const steps = (): Array<"machine" | "access"> => (pickMachine() || asksAddress() ? ["machine", "access"] : ["access"]);
  const current = () => (steps().includes(step()) ? step() : "access");
  const machineReady = () => target().kind !== "none" && (useExisting() || !needsAddress() || address().trim().length > 0);
  const ready = () => machineReady() && (useExisting() || pairingCode().trim().length > 0);
  const finishesHere = () => current() === "access" || useExisting();
  const reset = () => {
    choice.set(null); address.set(item().url ?? ""); access.set(linkRequestDefaultAccess(item())); pairingCode.set(""); step.set("machine"); error.set(null);
  };
  const close = () => { props.open.set(false); reset(); };
  const submit = async () => {
    const chosen = target();
    if (busy() || chosen.kind === "none") return;
    const input = chosen.kind === "machine" && chosen.linked
      ? linkRequestAnswerInput(item(), { type: "use-existing", environmentId: chosen.environmentId })
      : linkRequestAnswerInput(item(), {
        type: "link",
        target: chosen.kind === "address" ? { url: address() } : { ...chosen, urls: needsAddress() ? [address().trim()] : chosen.urls },
        access: access(),
        pairingCode: pairingCode(),
      });
    if (input === null) return;
    busy.set(true);
    error.set(null);
    try {
      await (props.send ?? requestBackend)("peerLinks.answerRequest", input);
      close();
    } catch (cause) { error.set(linkRequestFailureMessage(cause)); }
    finally { busy.set(false); }
  };
  const onSubmit = () => { if (finishesHere()) void submit(); else if (machineReady()) step.set("access"); };
  const fieldClass = "h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
  const radio = (value: string, label: string) => (
    <View class="flex-row items-center gap-2.5 rounded-lg border border-border px-3 py-2" onPress={() => { choice.set(value); error.set(null); }} accessibilityLabel={label} accessibilityState={{ checked: (choice() ?? null) === value }} role="radio" disabled={busy()}>
      <View class={`size-4 items-center justify-center rounded-full border ${choice() === value ? "border-primary" : "border-input"}`}>
        {choice() === value ? <View class="size-2 rounded-full bg-primary" /> : null}
      </View>
      <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{label}</Text>
    </View>
  );
  return (
    <Dialog
      open={props.open()}
      animation="fade"
      onOpenChange={({ open }) => { if (open) { loadLinks(); props.open.set(true); } else if (!busy()) close(); }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 448, maxWidth: "90%" }, dialogPopupMotion(() => props.open())]}
    >
      <View class="relative gap-4 rounded-2xl border border-border bg-background p-6" onPress={keepPressInDialog}>
        <DialogCloseButton onClose={() => { if (!busy()) close(); }} />
        <View class="gap-1">
          <Text class="text-lg font-semibold text-foreground">{pickMachine() ? "Link a machine" : `Link ${targetName()}`}</Text>
          <Text class="text-sm text-muted-foreground">Agents here can then launch, message and wait on threads there. Revoke it in that machine's Connections.</Text>
        </View>
        {steps().length > 1 && !useExisting() ? (
          <View class="flex-row gap-3">
            {(["Machine", "Access"] as const).map((label, index) => (
              <View
                class="flex-row items-center gap-1.5"
                onPress={() => { const next = steps()[index]; if (next) step.set(next); }}
                disabled={busy() || (index === 1 && !machineReady())}
                accessibilityLabel={label}
                accessibilityState={{ selected: steps().indexOf(current()) === index }}
                role="tab"
              >
                <Text class={steps().indexOf(current()) === index ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>{`${index + 1}. ${label}`}</Text>
                {index === 0 && target().kind !== "none" ? <Text class="text-xs text-muted-foreground">{targetName()}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}
        {current() === "machine" ? (
          <View class="gap-4">
            {pickMachine() ? (
              <View class="gap-2">
                <Text class="text-xs font-medium text-foreground">Machine</Text>
                {radio(ANOTHER_ADDRESS, "Another address…")}
              </View>
            ) : null}
            {asksAddress() ? (
              <View class="gap-1.5">
                <Text class="text-xs font-medium text-foreground">Address</Text>
                <Input accessibilityLabel="Address" value={address()} placeholder="https://machine.tailnet.ts.net" readonly={busy()} onChange={(event) => address.set(event.value)} onSubmit={onSubmit} class={fieldClass} />
                {target().kind === "machine" ? <Text class="text-xs text-muted-foreground">{`This app has no address for ${targetName()} that another machine can reach. Enter its https or Tailscale address.`}</Text> : null}
              </View>
            ) : null}
          </View>
        ) : (
          <View class="gap-4">
            {item().url !== undefined && !pickMachine() ? <Text class="truncate text-xs text-muted-foreground">{item().url}</Text> : null}
            {useExisting() ? null : (
              <View class="gap-4">
                <View class="gap-1.5">
                  <Text class="text-xs font-medium text-foreground">Pairing code</Text>
                  <Input accessibilityLabel="Pairing code" value={pairingCode()} placeholder="Paste the code" readonly={busy()} onChange={(event) => pairingCode.set(event.value)} onSubmit={onSubmit} class={fieldClass} />
                  <Text class="text-xs text-muted-foreground">{`Create a link on ${targetName()}: Settings → Connections → Create link, then paste its code here.`}</Text>
                </View>
                <View class="gap-1.5">
                  <Text class="text-xs font-medium text-foreground">What agents here may do there</Text>
                  {/* nsh-runtime-bugs.md #8: a Menu popup opened inside a Dialog takes no presses on this host, so the
                      options lay out inline under the trigger (as SettingsSelect inline does in dialogs). */}
                  <View
                    class={`${fieldClass} flex-row items-center justify-between`}
                    accessibilityLabel={`Access: ${accessConfig[access()].label}`}
                    accessibilityState={{ expanded: accessMenuOpen() }}
                    role="button"
                    onPress={() => accessMenuOpen.update((open) => !open)}
                  >
                    <Text class="text-sm text-foreground">{accessConfig[access()].label}</Text>
                    <TimelineIcon name={accessMenuOpen() ? "chevron-up" : "chevron-down"} size={14} />
                  </View>
                  {accessMenuOpen() ? (
                    <View class="rounded-lg border border-border bg-popover p-1" role="menu" accessibilityLabel="Access options">
                      {LINK_ACCESS_OPTIONS.map((option) => (
                        <View
                          accessibilityLabel={accessConfig[option].label}
                          accessibilityState={{ selected: access() === option }}
                          role="menuitem"
                          class={`gap-0.5 rounded-sm px-2 py-1.5 hover:bg-accent ${access() === option ? "bg-accent" : ""}`}
                          onPress={() => { access.set(option); accessMenuOpen.set(false); }}
                        >
                          <Text class="text-sm font-medium text-popover-foreground">{accessConfig[option].label}</Text>
                          <Text class="text-xs text-muted-foreground">{accessConfig[option].description}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                  <Text class="text-xs text-muted-foreground">{`${accessConfig[access()].description} An agent never gets more access there than its own mode here. Below full access, it can change only threads this link started, not that machine's own threads, projects or settings.`}</Text>
                </View>
              </View>
            )}
          </View>
        )}
        {useExisting() ? <Text class="text-xs text-muted-foreground">{`This environment is already linked to ${targetName()}. The agent can use that link as it is; change its access in Settings → Connections.`}</Text> : null}
        {error() !== null ? <Text class="text-xs text-destructive" role="alert">{error()}</Text> : null}
        <View class="flex-row justify-end gap-2">
          {current() === "access" && steps().length > 1 ? (
            <View class={`h-8 ${buttonClass.slice(4)} border border-input hover:bg-accent`} disabled={busy()} onPress={() => { step.set("machine"); error.set(null); }} accessibilityLabel="Back" role="button"><Text class="text-sm text-foreground">Back</Text></View>
          ) : (
            <View class={`h-8 ${buttonClass.slice(4)} border border-input hover:bg-accent`} disabled={busy()} onPress={close} accessibilityLabel="Cancel" role="button"><Text class="text-sm text-foreground">Cancel</Text></View>
          )}
          <View
            class={`h-8 ${buttonClass.slice(4)} bg-primary`}
            disabled={busy() || (finishesHere() ? !ready() : !machineReady())}
            onPress={onSubmit}
            accessibilityLabel={busy() ? "Linking…" : useExisting() ? "Use this link" : finishesHere() ? "Link" : "Continue"}
            role="button"
          >
            <Text class="text-sm font-medium text-primary-foreground">{busy() ? "Linking…" : useExisting() ? "Use this link" : finishesHere() ? "Link" : "Continue"}</Text>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
