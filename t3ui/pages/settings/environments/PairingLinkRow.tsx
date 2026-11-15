// The rows of the Authorized clients list (AuthorizedClientsSettings.tsx PairingLinkListRow and
// ConnectedClientListRow): a pairing link with Share (the QR panel, the "Reach this machine via" endpoint
// selector, Copy link, Copy code only), Copy code, a manual-copy dialog for a failed clipboard write, and
// Revoke; and a signed-in client with its device line and Revoke.
import { Clipboard, signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { DialogInput } from "../../../components/DialogInput";
import { SettingsButton } from "../../../components/SettingsLayout";
import { SettingsDialog } from "../../../components/SettingsDialog";
import { QrCodeView } from "../../../components/QrCodeView";
import { showToast } from "../../../components/toast";
import { Tip } from "../../../components/sidebar/Tip";
import { MotionLoop } from "../../../components/motion/Motion";
import { statusPing } from "../../../components/motion/motionTokens";
import { SettingsIcon } from "../SettingsIcon";
import { codeTextStyle } from "../../../typography";
import type { ClientSession, PairingLink } from "./accessClients";
import { formatExpiresInLabel } from "./accessClients";
import {
  endpointCopyOptions, formatAccessTimestamp, isHostedAppPairingUrl, selectQrEndpointOption, shareablePairingUrl,
  type AdvertisedEndpoint,
} from "./connectionsLogic";

const DESTRUCTIVE_BUTTON = "h-6 items-center justify-center rounded-lg border border-destructive-foreground px-2 active:scale-[0.97] transition-transform duration-150 ease-in-out";

/** AccessScopeSummary: "N scopes", and the granted scopes in the tooltip the web opens on hover. */
export function ScopeSummary(props: { scopes: readonly string[]; label: string }) {
  const count = `${props.scopes.length} ${props.scopes.length === 1 ? "scope" : "scopes"}`;
  return (
    <View
      role="button"
      accessibilityLabel={`${props.label}: show ${count}`}
      tooltip={
        <Tooltip placement="top" class="max-w-80 gap-0.5 rounded-md border border-border bg-popover px-2 py-1.5">
          <Text class="mb-0.5 text-xs font-medium text-popover-foreground">Granted scopes</Text>
          {props.scopes.map((scope) => <Text class="text-xs text-popover-foreground">{scope}</Text>)}
        </Tooltip>
      }
    >
      <Text class="text-xs text-muted-foreground underline">{count}</Text>
    </View>
  );
}

/** ConnectionStatusDot: the dot, with a tooltip, and a motion-safe status ping ring behind a live one (pingClassName "bg-success/60 duration-2000"). */
function StatusDot(props: { tone: "success" | "warning" | "muted"; tip?: string | null; ping?: boolean }) {
  const dot = <View class={`size-2 rounded-full ${props.tone === "success" ? "bg-success" : props.tone === "warning" ? "bg-warning" : "bg-muted-foreground-70"}`} />;
  const body = (
    <View class="size-3 shrink-0 items-center justify-center">
      {props.ping ? <View class="absolute size-2" style={{ opacity: 0.6 }}><MotionLoop spec={statusPing} class="size-2 rounded-full bg-success" /></View> : null}
      {dot}
    </View>
  );
  return props.tip ? <View tooltip={<Tip label={props.tip} />}>{body}</View> : body;
}

type CopyKind = "code" | "hosted-link" | "link";

const copyToast = (kind: CopyKind) => ({
  title: kind === "hosted-link" ? "Hosted app link copied" : kind === "link" ? "Pairing URL copied" : "Pairing code copied",
  description: kind === "hosted-link" ? "Open it in the browser on the device you want to connect." : kind === "link" ? "Open it in the client you want to pair to this environment." : "Paste it into another client to finish pairing.",
});
const copyFailureTitle = (kind: CopyKind) => (kind === "hosted-link" ? "Could not copy hosted app link" : kind === "link" ? "Could not copy pairing URL" : "Could not copy pairing code");

/** The state of the pairing rows that outlives a row's rebuild: which value a failed copy reveals, per link id. */
const revealed = signal<Record<string, string | null>>({});
const shareOpen = signal<Record<string, boolean>>({});
const qrChoice = signal<Record<string, string | null>>({});

export interface PairingLinkRowProps {
  link: PairingLink;
  credential: string | undefined;
  /** Opens the share panel on arrival: the link just created here. */
  defaultShareOpen: boolean;
  /** The connected environment's origin when this app is served by it (its own address), else null. */
  currentOrigin: string | null;
  endpointUrl?: string | null;
  endpoints: readonly AdvertisedEndpoint[];
  defaultEndpointKey: string | null;
  now: number;
  revoking: boolean;
  canRevoke: boolean;
  onRevoke: () => void;
}

export function PairingLinkRow(props: PairingLinkRowProps) {
  const link = props.link;
  const id = link.id;
  const isOpen = () => shareOpen()[id] ?? props.defaultShareOpen;
  const options = () => endpointCopyOptions(props.endpoints, props.credential);
  const shareUrl = () => shareablePairingUrl({ credential: props.credential, endpoints: props.endpoints, defaultEndpointKey: props.defaultEndpointKey, endpointUrl: props.endpointUrl, currentOrigin: props.currentOrigin });
  const selected = () => selectQrEndpointOption(options(), qrChoice()[id] ?? null, props.defaultEndpointKey);
  const qrUrl = () => selected()?.url ?? shareUrl();
  const qrOk = () => selected()?.qrShareable ?? true;
  const revealValue = () => revealed()[id] ?? shareUrl() ?? props.credential ?? "";
  const revealIsUrl = () => revealValue() !== props.credential;
  const revealHosted = () => revealIsUrl() && isHostedAppPairingUrl(revealValue());
  const revealOpen = () => props.credential !== undefined && revealed()[id] !== undefined && revealed()[id] !== null;

  const copy = async (value: string, kind: CopyKind) => {
    try {
      await Clipboard.writeText(value);
      showToast({ type: "success", ...copyToast(kind) });
    } catch (error) {
      revealed.update((all) => ({ ...all, [id]: value }));
      showToast({ type: "error", title: copyFailureTitle(kind), description: error instanceof Error ? error.message : "Showing the full value instead." });
    }
  };
  const copyKindForUrl = (url: string): CopyKind => (isHostedAppPairingUrl(url) ? "hosted-link" : "link");
  const closeReveal = () => revealed.update((all) => ({ ...all, [id]: null }));

  if (new Date(link.expiresAt).getTime() <= props.now) return null;
  return (
    <View testID={`Pairing link ${id}`}>
      <View class="flex-row items-center justify-between gap-3 px-4 py-3">
        <View class="min-w-0 flex-1 gap-1">
          <View class="min-h-5 flex-row items-center gap-1.5">
            <StatusDot tone="warning" tip={`Link created at ${formatAccessTimestamp(link.createdAt)}`} />
            <Text class="text-sm font-medium text-foreground">{link.label ?? "Pairing link"}</Text>
          </View>
          <View class="flex-row items-center gap-1">
            <View tooltip={<Tip label={formatAccessTimestamp(link.expiresAt)} />}><Text class="text-xs text-muted-foreground">{formatExpiresInLabel(link.expiresAt, props.now)}</Text></View>
            <Text class="text-xs text-muted-foreground">·</Text>
            <ScopeSummary scopes={link.scopes} label="Pairing link scopes" />
          </View>
          {!props.credential ? (
            <Text class="text-2xs text-muted-foreground-70">Create a new link to share from this client.</Text>
          ) : shareUrl() === null ? (
            <Text class="text-2xs text-muted-foreground-70">Copy the token and pair from another client using this backend&apos;s reachable host.</Text>
          ) : null}
        </View>
        <View class="flex-row items-center gap-2">
          {shareUrl() ? (
            <View
              role="button"
              accessibilityLabel="Share"
              onPress={() => shareOpen.update((all) => ({ ...all, [id]: !isOpen() }))}
              class="h-6 flex-row items-center gap-1 rounded-lg border border-input bg-background px-2 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
            >
              <SettingsIcon name="qr-code" size={14} />
              <Text class="text-xs font-medium text-foreground">Share</Text>
            </View>
          ) : null}
          {props.credential && !shareUrl() ? (
            <SettingsButton label="Copy code" onPress={() => void copy(props.credential!, "code")} />
          ) : null}
          <View
            role="button"
            accessibilityLabel="Revoke pairing link"
            disabled={!props.canRevoke || props.revoking}
            onPress={props.onRevoke}
            class={DESTRUCTIVE_BUTTON}
          >
            <Text class="text-xs font-medium text-destructive-foreground">{props.revoking ? "Revoking…" : "Revoke"}</Text>
          </View>
        </View>
      </View>
      {isOpen() && qrUrl() !== null ? (
        <View class="mx-4 mb-3 flex-row items-start justify-between gap-4 border-t border-border-50 pt-3" testID={`Share panel ${id}`}>
          <View class="min-w-0 flex-1 gap-3">
            {options().length > 1 ? (
              <View class="gap-1.5" role="group" accessibilityLabel="Endpoint the pairing QR code and URL use">
                <Text class="text-2xs text-muted-foreground-70">Reach this machine via</Text>
                {options().map((option) => {
                  const on = () => option.id === selected()?.id;
                  return (
                    <View
                      role="button"
                      accessibilityLabel={option.label}
                      onPress={() => qrChoice.update((all) => ({ ...all, [id]: option.id }))}
                      class={`flex-row items-baseline gap-2 rounded-lg border px-2.5 py-1.5 ${on() ? "border-foreground bg-muted-30" : "border-border-50 hover:bg-muted-10"}`}
                    >
                      <Text class={`text-xs font-medium ${on() ? "text-foreground" : "text-muted-foreground"}`}>{option.label}</Text>
                      <Text class="min-w-0 flex-1 truncate text-2xs text-muted-foreground-70">{option.detail}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}
            <View class="flex-row items-center gap-2 rounded-lg border border-border-60 bg-muted-30 px-2.5 py-1.5">
              <View class="min-w-0 flex-1" tooltip={<Tip label={qrUrl()!} />}><Text class="truncate text-2xs text-muted-foreground" style={{ ...codeTextStyle(), fontSize: 11 }}>{qrUrl()!}</Text></View>
              <View role="button" accessibilityLabel="Copy link" onPress={() => void copy(qrUrl()!, copyKindForUrl(qrUrl()!))} class="h-6 items-center justify-center rounded-lg px-2 hover:bg-accent">
                <Text class="text-xs font-medium text-foreground">Copy link</Text>
              </View>
            </View>
            <View role="button" accessibilityLabel="Copy code only" onPress={() => { if (props.credential) void copy(props.credential, "code"); }} class="h-6 items-start justify-center self-start rounded-lg px-2 hover:bg-accent">
              <Text class="text-xs font-medium text-foreground">Copy code only</Text>
            </View>
          </View>
          {qrOk() ? (
            <QrCodeView value={qrUrl()!} size={168} level="M" marginSize={1} title="Pairing link. Scan to open on another device" />
          ) : (
            <View class="items-center justify-center rounded-xl border border-border-50 p-4" style={{ width: 192, height: 192 }}>
              <Text class="text-center text-2xs text-muted-foreground-70">No QR for this endpoint. Another device scanning a loopback link would dial itself; copy the URL for use on this machine instead.</Text>
            </View>
          )}
        </View>
      ) : null}
      <SettingsDialog
        open={revealOpen()}
        onClose={closeReveal}
        title={revealIsUrl() ? (revealHosted() ? "Hosted app pairing link" : "Pairing link") : "Pairing code"}
        description={revealIsUrl()
          ? revealHosted()
            ? "Clipboard copy is unavailable here. Open or manually copy this hosted app link on the device you want to connect."
            : "Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect."
          : "Clipboard copy is unavailable here. Manually copy this code into another client."}
        width={448}
        testID={`Reveal ${id}`}
        footer={
          <>
            <SettingsButton label="Done" onPress={closeReveal} />
            <SettingsButton label="Copy code" accessibilityLabel="Copy code (dialog)" onPress={() => { if (props.credential) void copy(props.credential, "code"); }} />
          </>
        }
      >
        <DialogInput accessibilityLabel="Pairing value" value={revealValue()} readonly class="h-8 w-full rounded-lg border border-input bg-background px-3 text-xs text-foreground" />
        {revealIsUrl() && (selected()?.qrShareable ?? true) ? (
          <View class="items-center rounded-xl border border-border-60 bg-muted-30 p-4"><QrCodeView value={revealValue()} size={132} level="M" marginSize={2} title="Pairing link. Scan to open on another device" /></View>
        ) : null}
      </SettingsDialog>
    </View>
  );
}

/** ConnectedClientListRow. */
export function ConnectedClientRow(props: { session: ClientSession; now: number; revoking: boolean; canRevoke: boolean; onRevoke: () => void }) {
  const session = props.session;
  const live = session.current || session.connected;
  const kind = session.client.deviceType && session.client.deviceType !== "unknown" ? session.client.deviceType[0]!.toUpperCase() + session.client.deviceType.slice(1) : null;
  const bits = [kind, session.client.os, session.client.browser, session.client.ipAddress].filter((bit): bit is string => Boolean(bit));
  const title = session.client.label ?? ([session.client.os, session.client.browser].filter(Boolean).join(" · ") || session.subject);
  const tip = live
    ? session.lastConnectedAt ? `Connected for ${elapsedLabel(session.lastConnectedAt, props.now)}` : "Connected"
    : session.lastConnectedAt ? `Last connected at ${formatAccessTimestamp(session.lastConnectedAt)}` : "Not connected yet.";
  return (
    <View class="flex-row items-center justify-between gap-3 px-4 py-3" testID={`Client ${session.sessionId}`}>
      <View class="min-w-0 flex-1 gap-1">
        <View class="min-h-5 flex-row items-center gap-1.5">
          <StatusDot tone={live ? "success" : "muted"} tip={tip} ping={live} />
          <Text class="text-sm font-medium text-foreground">{title}</Text>
          {session.current ? (
            <View class="rounded-md border border-border-50 bg-muted-50 px-1 py-0.5"><Text class="text-3xs text-muted-foreground-80">This device</Text></View>
          ) : null}
        </View>
        <View class="flex-row items-center gap-1">
          {bits.length > 0 ? <Text class="text-xs text-muted-foreground">{`${bits.join(" · ")} ·`}</Text> : null}
          <ScopeSummary scopes={session.scopes} label="Client scopes" />
        </View>
      </View>
      {!session.current ? (
        <View role="button" accessibilityLabel="Revoke client" disabled={!props.canRevoke || props.revoking} onPress={props.onRevoke} class={DESTRUCTIVE_BUTTON}>
          <Text class="text-xs font-medium text-destructive-foreground">{props.revoking ? "Revoking…" : "Revoke"}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** formatElapsedDurationLabel (timestampFormat.ts): "just now", then the largest unit. */
export function elapsedLabel(from: string, now: number): string {
  const diff = now - new Date(from).getTime();
  if (Number.isNaN(diff) || diff <= 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
