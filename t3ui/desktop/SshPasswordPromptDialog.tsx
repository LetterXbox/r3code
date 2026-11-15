// SshPasswordPromptDialog.tsx: the first queued SSH prompt, its countdown, the password field, Cancel / Continue;
// an expired prompt says so and its button becomes Dismiss.
import { effect, signal, Text, View } from "nsh";
import { SettingsDialog } from "../components/SettingsDialog";
import { SettingsButton } from "../components/SettingsLayout";
import { DialogInput } from "../components/DialogInput";
import { EXPIRED_MESSAGE, formatRemainingSeconds, sshPasswordPrompts, type SshPasswordPromptRequest } from "./sshPasswordPrompts";

const describeSshTarget = (request: SshPasswordPromptRequest) => (request.username ? `${request.username}@${request.destination}` : request.destination);

function promptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "SSH verification prompt failed.";
  return message.includes("expired") || message.includes("no longer pending") ? EXPIRED_MESSAGE : message;
}

export function SshPasswordPromptDialogHost(props: { service?: ReturnType<typeof sshPasswordPrompts> } = {}) {
  const service = props.service ?? sshPasswordPrompts();
  if (!service) return null;
  const password = signal("");
  const responding = signal(false);
  const error = signal<string | null>(null);
  const now = signal(Date.now());
  let shownId: string | null = null;
  effect(() => {
    const request = service.queue()[0];
    if (!request) return;
    if (request.requestId !== shownId) { shownId = request.requestId; password.set(""); error.set(null); responding.set(false); }
    const id = setInterval(() => now.set(Date.now()), 1000);
    return () => clearInterval(id);
  });
  const respond = async (request: SshPasswordPromptRequest, next: string | null) => {
    if (responding()) return;
    if (next !== null && request.expiresAt <= now()) { error.set(EXPIRED_MESSAGE); return; }
    responding.set(true);
    error.set(null);
    try { await service.resolve(request.requestId, next); } catch (cause) {
      if (next === null) service.dismiss(request.requestId); else error.set(promptErrorMessage(cause));
    }
    responding.set(false);
  };
  return () => {
    const request = service.queue()[0];
    if (!request) return null;
    const remaining = Math.max(0, Math.ceil((request.expiresAt - now()) / 1000));
    const expired = remaining === 0;
    const cancel = () => { if (expired) service.dismiss(request.requestId); else void respond(request, null); };
    const visibleError = expired ? EXPIRED_MESSAGE : error();
    return (
      <SettingsDialog
        open
        width={448}
        onClose={cancel}
        title="SSH verification required"
        description={`Enter the password or verification code required by ${describeSshTarget(request)}. T3 Code passes your response to the local SSH process and keeps it in memory to reuse for this host. T3 Code does not write it to disk.`}
        footer={<>
          <SettingsButton label={expired ? "Dismiss" : "Cancel"} disabled={responding()} onPress={cancel} />
          <SettingsButton tone="primary" label="Continue" disabled={responding() || expired} onPress={() => void respond(request, password())} />
        </>}
      >
        <View class="gap-3">
          <View class="gap-2">
            <View class="flex-row items-center justify-between gap-3">
              <Text class="text-sm font-medium text-foreground">{request.prompt}</Text>
              <Text class={expired ? "shrink-0 text-xs font-medium text-destructive" : "shrink-0 text-xs text-muted-foreground"}>{expired ? "Expired" : formatRemainingSeconds(remaining)}</Text>
            </View>
            <DialogInput
              accessibilityLabel="SSH password"
              masked
              autoComplete="current-password"
              disabled={responding() || expired}
              value={password()}
              onChange={(event: { value: string }) => password.set(event.value)}
              onSubmit={() => void respond(request, password())}
              class="h-8 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
            />
          </View>
          {visibleError ? <Text class="text-sm text-destructive">{visibleError}</Text> : <Text class="text-sm text-muted-foreground">SSH keys may replace a password, but your server can still require a verification code.</Text>}
        </View>
      </SettingsDialog>
    );
  };
}
