// The T3 Connect account pages (T3ConnectAccountPages.tsx: Mobile clients, T3 Connect, T3 Chat) and the signed-in
// avatar (T3ConnectSidebarAvatar). The reference renders them inside Clerk's user-profile modal; here they are a
// dialog with the same three pages and copy, plus sign-out (Clerk's UserButton menu has "Sign out").
import { Image, openUrl, signal, Text, token, View } from "nsh";
import { SettingsDialog } from "../components/SettingsDialog";
import { SettingsButton } from "../components/SettingsLayout";
import serverIcon from "../icons/server.svg";
import smartphoneIcon from "../icons/smartphone.svg";
import messageIcon from "../icons/message-square.svg";
import {
  deregisterEnvironment, deregisteringEnvironmentId, linkT3Chat, managedTunnelUsage, refreshTunnelUsage, relayDevices,
  relayEnvironments, relayT3ChatLink, resetAccountState, t3ChatLinkPending, t3ChatPendingLinkUrl, unlinkT3ChatAccount,
} from "./accountState";
import { connectAuthState, signOutOfConnect } from "./connectSession";
import {
  endpointLabel, linkedAtLabel, mobileClientNotificationDetail, mobileClientPlatformLabel, mobileClientUpdatedAtLabel,
  T3CHAT_PLAN_TUNNEL_LIMITS, T3CHAT_SUBSCRIPTION_URL, t3ChatPlanLabel, tunnelUpgradeCopy, type RelayDeviceRecord, type RelayEnvironmentRecord,
} from "./relayClient";

export type AccountPage = "mobile-clients" | "t3-connect" | "t3-chat";
export const T3_CONNECT_ACCOUNT_PAGES: { url: AccountPage; label: string; icon: any }[] = [
  { url: "mobile-clients", label: "Mobile clients", icon: smartphoneIcon },
  { url: "t3-connect", label: "T3 Connect", icon: serverIcon },
  { url: "t3-chat", label: "T3 Chat", icon: messageIcon },
];

const openPage = signal<AccountPage | null>(null);
export const accountPageOpen = () => openPage();

/** useT3ConnectAccountPage.open: defaults to the T3 Connect page. */
export function openAccountPage(page: AccountPage = "t3-connect") {
  openPage.set(page);
  if (page === "mobile-clients") void relayDevices.refresh();
  else refreshTunnelUsage();
}

const PageIcon = (props: { src: any; size?: number }) => <Image src={props.src} style={{ width: props.size ?? 16, height: props.size ?? 16, tintColor: token("muted-foreground") }} />;

/** ClerkUserProfilePage frame: title, description, action. */
function ProfilePage(props: { title: string; description: string; action?: any; children?: any }) {
  return (
    <View class="min-w-0 flex-1">
      <View class="flex-row items-center justify-between gap-4 pb-4 pr-8">
        <View class="min-w-0 flex-1">
          <Text class="text-base font-semibold text-foreground">{props.title}</Text>
          <Text class="mt-1 text-xs text-muted-foreground">{props.description}</Text>
        </View>
        {props.action ?? null}
      </View>
      {props.children}
    </View>
  );
}

function RefreshButton(props: { pending: boolean; disabled?: boolean; onPress: () => void }) {
  return <SettingsButton label="Refresh" disabled={props.pending || props.disabled === true} onPress={props.onPress} />;
}

/** ClerkUserProfileRow: border-t py-4, size-8 icon tile. */
function ProfileRow(props: { icon: any; first?: boolean; children?: any }) {
  return (
    <View class={props.first ? "py-4" : "border-t border-border py-4"}>
      <View class="flex-row items-start gap-3">
        <View class="size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted"><PageIcon src={props.icon} /></View>
        <View class="min-w-0 flex-1">{props.children}</View>
      </View>
    </View>
  );
}

function ErrorBlock(props: { title: string; message: string; retry?: () => void }) {
  return (
    <View class="mb-4 flex-row items-center justify-between gap-3 border-t border-border py-3" role="alert">
      <View class="min-w-0 flex-1">
        <Text class="text-xs font-medium text-destructive-foreground">{props.title}</Text>
        <Text class="mt-0.5 text-xs text-muted-foreground">{props.message}</Text>
      </View>
      {props.retry ? <SettingsButton label="Try again" onPress={props.retry} /> : null}
    </View>
  );
}

function EmptyState(props: { icon: any; title: string; description: string }) {
  return (
    <View class="items-center gap-2 border-t border-border px-6 py-8">
      <View class="size-9 items-center justify-center rounded-md bg-muted"><PageIcon src={props.icon} size={18} /></View>
      <Text class="text-sm font-medium text-foreground">{props.title}</Text>
      <Text class="text-center text-sm text-muted-foreground">{props.description}</Text>
    </View>
  );
}

/** TunnelUsageMeter: "N of M tunnels in use", one slot per tunnel up to 10, else a filled bar. */
export function TunnelUsageMeter(props: { used: number; limit: number }) {
  const full = props.used >= props.limit;
  return (
    <View class="max-w-sm gap-1.5" accessibilityLabel="T3 Connect tunnels in use">
      <Text class={full ? "text-xs text-warning-foreground" : "text-xs text-foreground"}>{`${props.used} of ${props.limit} tunnels in use`}</Text>
      <View class="h-1.5 flex-row gap-1">
        {props.limit <= 10
          ? Array.from({ length: props.limit }, (_, index) => <View class={`flex-1 rounded-full ${index < props.used ? (full ? "bg-warning" : "bg-foreground") : "bg-muted"}`} />)
          : <View class="flex-1 overflow-hidden rounded-full bg-muted"><View class={`h-1.5 rounded-full ${full ? "bg-warning" : "bg-foreground"}`} style={{ width: `${Math.min(100, (props.used / props.limit) * 100)}%` }} /></View>}
      </View>
    </View>
  );
}

function TextLink(props: { label: string; url: string }) {
  return <Text class="text-xs text-muted-foreground underline" onPress={() => void openUrl(props.url).catch(() => undefined)}>{props.label}</Text>;
}

function MobileClientsPage() {
  return () => {
    const state = relayDevices.state();
    const devices = state.data ?? [];
    const initial = state.data === null && !state.error;
    return (
      <ProfilePage title="Mobile clients" description="Mobile devices that get notifications from your environments." action={<RefreshButton pending={state.pending} onPress={() => void relayDevices.refresh()} />}>
        {state.error ? <ErrorBlock title="Could not load mobile clients" message={state.error} retry={() => void relayDevices.refresh()} /> : null}
        {initial ? <Text class="border-t border-border py-4 text-xs text-muted-foreground" accessibilityLabel="Loading mobile clients">Loading mobile clients</Text>
          : state.error && state.data === null ? null
          : devices.length > 0 ? <View class="border-t border-border">{devices.map((device, index) => <MobileClientRow device={device} first={index === 0} />)}</View>
          : <EmptyState icon={smartphoneIcon} title="No mobile clients" description="Install T3 Code on your phone and sign in to T3 Connect to get push notifications and Live Activities." />}
      </ProfilePage>
    );
  };
}

function StatusBadge(props: { enabled: boolean; label: string }) {
  return (
    <View class={props.enabled ? "rounded-sm bg-success px-1.5 py-0.5" : "rounded-sm border border-border px-1.5 py-0.5"}>
      <Text class={props.enabled ? "text-2xs font-medium text-success-foreground" : "text-2xs font-medium text-foreground"}>{`${props.label}: ${props.enabled ? "On" : "Off"}`}</Text>
    </View>
  );
}

function MobileClientRow(props: { device: RelayDeviceRecord; first: boolean }) {
  const device = props.device;
  return (
    <ProfileRow icon={smartphoneIcon} first={props.first}>
      <View class="flex-row items-start justify-between gap-3">
        <View class="min-w-0 flex-1">
          <Text class="truncate text-sm font-medium text-foreground">{device.label}</Text>
          <Text class="text-xs text-muted-foreground">{mobileClientPlatformLabel(device)}</Text>
        </View>
        <Text class="shrink-0 text-2xs text-muted-foreground">{mobileClientUpdatedAtLabel(device.updatedAt)}</Text>
      </View>
      <View class="mt-2 flex-row flex-wrap gap-1.5">
        <StatusBadge enabled={device.notifications.enabled} label="Push notifications" />
        <StatusBadge enabled={device.liveActivities.enabled} label="Live Activities" />
      </View>
      <Text class="mt-1.5 text-xs text-muted-foreground">{mobileClientNotificationDetail(device)}</Text>
    </ProfileRow>
  );
}

const confirming = signal<string | null>(null);

function EnvironmentRow(props: { environment: RelayEnvironmentRecord; first: boolean }) {
  return () => {
    const environment = props.environment;
    const pending = deregisteringEnvironmentId() !== null;
    return (
      <ProfileRow icon={serverIcon} first={props.first}>
        <View class="flex-row items-start gap-4">
          <View class="min-w-0 flex-1">
            <Text class="truncate text-sm font-medium text-foreground">{environment.label}</Text>
            <Text class="mt-1 text-xs text-muted-foreground">{`${linkedAtLabel(environment.linkedAt)} · ${endpointLabel(environment)}`}</Text>
          </View>
          <SettingsButton tone="destructive" label="Deregister" disabled={pending} onPress={() => confirming.set(confirming() === environment.environmentId ? null : environment.environmentId)} />
        </View>
        {confirming() === environment.environmentId ? (
          <View class="pt-3">
            <View class="rounded-lg border border-input bg-muted px-5 py-4" accessibilityLabel={`Confirm deregistration of ${environment.label}`}>
              <Text class="text-sm font-semibold text-foreground">Deregister server</Text>
              <Text class="mt-1 text-xs text-muted-foreground">{`“${environment.label}” will be removed from this account.`}</Text>
              <Text class="mt-4 text-xs text-muted-foreground">T3 Connect access will be revoked, any managed tunnel will be removed, and a host space will become available. Local connections on your devices are not changed.</Text>
              <View class="mt-4 flex-row justify-end gap-2">
                <SettingsButton tone="ghost" label="Cancel" disabled={pending} onPress={() => confirming.set(null)} />
                <SettingsButton tone="destructive" label={pending ? "Deregistering…" : "Deregister"} disabled={pending} onPress={() => void deregisterEnvironment(environment).then(() => confirming.set(null))} />
              </View>
            </View>
          </View>
        ) : null}
      </ProfileRow>
    );
  };
}

function TunnelUsageBlock() {
  return () => {
    const usage = managedTunnelUsage();
    if (usage.used === null || usage.limit === null) return null;
    const linkUrl = t3ChatPendingLinkUrl();
    return (
      <View class="border-t border-border py-4">
        <TunnelUsageMeter used={usage.used} limit={usage.limit} />
        {usage.upgrade ? (
          <View class="mt-2 flex-row flex-wrap items-baseline gap-1">
            {usage.upgrade === "link" && linkUrl ? (
              <><Text class="text-xs text-muted-foreground">Confirm on</Text><TextLink label="t3.chat" url={linkUrl} /><Text class="text-xs text-muted-foreground">, then select Refresh.</Text></>
            ) : (
              <>
                <Text class="text-xs text-muted-foreground">{tunnelUpgradeCopy(usage.upgrade)}</Text>
                {usage.upgrade === "link"
                  ? <Text class="text-xs text-foreground underline" onPress={() => { if (t3ChatLinkPending() === null) void linkT3Chat(); }}>{t3ChatLinkPending() === "link" ? "Opening…" : "Link T3 Chat"}</Text>
                  : <TextLink label="Upgrade on T3 Chat" url={T3CHAT_SUBSCRIPTION_URL} />}
              </>
            )}
          </View>
        ) : null}
      </View>
    );
  };
}

function T3ConnectPage() {
  return () => {
    const state = relayEnvironments.state();
    const environments = state.data ?? [];
    const initial = state.data === null && !state.error;
    return (
      <ProfilePage title="T3 Connect" description="Environments registered to your account. Connections on this device are managed in Settings."
        action={<RefreshButton pending={state.pending} disabled={deregisteringEnvironmentId() !== null} onPress={refreshTunnelUsage} />}>
        <TunnelUsageBlock />
        {state.error ? <ErrorBlock title="Could not load T3 Connect environments" message={state.error} /> : null}
        {initial ? <Text class="border-t border-border py-4 text-xs text-muted-foreground">Loading environments…</Text>
          : environments.length > 0 ? <View class="border-t border-border">{environments.map((environment, index) => <EnvironmentRow environment={environment} first={index === 0} />)}</View>
          : state.error ? null
          : <EmptyState icon={serverIcon} title="No T3 Connect environments" description="Link an environment from its local Settings to make it available through T3 Connect." />}
      </ProfilePage>
    );
  };
}

function T3ChatPage() {
  return () => {
    const state = relayT3ChatLink.state();
    const data = state.data;
    const link = data?.link ?? null;
    const pending = t3ChatLinkPending();
    const linkUrl = t3ChatPendingLinkUrl();
    const usage = managedTunnelUsage();
    return (
      <ProfilePage title="T3 Chat" description={`Link a paid T3 Chat account for more T3 Connect tunnels: up to ${T3CHAT_PLAN_TUNNEL_LIMITS.pro} with Pro, ${T3CHAT_PLAN_TUNNEL_LIMITS.premier} with Premier.`}
        action={<RefreshButton pending={state.pending} disabled={pending !== null} onPress={refreshTunnelUsage} />}>
        {state.error ? <ErrorBlock title="Could not load T3 Chat link" message={state.error} />
          : data === null ? null
          : !data.available ? <Text class="border-t border-border py-4 text-xs text-muted-foreground">This T3 Connect server does not support T3 Chat linking.</Text>
          : (
            <View class="border-t border-border">
              <ProfileRow icon={messageIcon} first>
                <View class="flex-row items-start gap-4">
                  <View class="min-w-0 flex-1">
                    <Text class="truncate text-sm font-medium text-foreground">{link ? link.email : "Not linked"}</Text>
                    {link ? (
                      link.plan === "premier" ? <Text class="mt-1 text-xs text-muted-foreground">{t3ChatPlanLabel("premier")}</Text>
                        : <View class="mt-1 flex-row flex-wrap items-baseline gap-1">
                            {link.plan === "pro" ? <Text class="text-xs text-muted-foreground">{`Pro · up to ${T3CHAT_PLAN_TUNNEL_LIMITS.pro} tunnels.`}</Text> : null}
                            <TextLink label="Upgrade on T3 Chat" url={T3CHAT_SUBSCRIPTION_URL} />
                            <Text class="text-xs text-muted-foreground">{link.plan === "pro" ? `to Premier for ${T3CHAT_PLAN_TUNNEL_LIMITS.premier}.` : "for more tunnels"}</Text>
                          </View>
                    ) : linkUrl ? (
                      <View class="mt-1 flex-row flex-wrap items-baseline gap-1"><Text class="text-xs text-muted-foreground">Confirm on</Text><TextLink label="t3.chat" url={linkUrl} /><Text class="text-xs text-muted-foreground">, then select Refresh.</Text></View>
                    ) : <Text class="mt-1 text-xs text-muted-foreground">You confirm the link on t3.chat.</Text>}
                  </View>
                  {link
                    ? <SettingsButton tone="destructive" label={pending === "unlink" ? "Unlinking…" : "Unlink"} disabled={pending !== null} onPress={() => void unlinkT3ChatAccount()} />
                    : <SettingsButton tone="primary" label={pending === "link" ? "Opening…" : "Link T3 Chat"} disabled={pending !== null} onPress={() => void linkT3Chat()} />}
                </View>
              </ProfileRow>
              {usage.used !== null && usage.limit !== null ? <View class="border-t border-border py-4"><TunnelUsageMeter used={usage.used} limit={usage.limit} /></View> : null}
            </View>
          )}
      </ProfilePage>
    );
  };
}

export function AccountPagesDialogHost() {
  return () => {
    const page = openPage();
    if (page === null) return null;
    const auth = connectAuthState();
    return (
      <SettingsDialog open width={768} title="Account" description={auth.status === "signed-in" && auth.identity ? auth.identity : undefined} onClose={() => openPage.set(null)}>
        <View class="min-h-[420px] flex-row gap-6">
          <View class="w-44 shrink-0 gap-1">
            {T3_CONNECT_ACCOUNT_PAGES.map((item) => (
              <View role="button" accessibilityLabel={item.label} onPress={() => openAccountPage(item.url)}
                class={item.url === page ? "h-8 flex-row items-center gap-2 rounded-md bg-accent px-2" : "h-8 flex-row items-center gap-2 rounded-md px-2 hover:bg-accent-50"}>
                <PageIcon src={item.icon} />
                <Text class="text-sm text-foreground">{item.label}</Text>
              </View>
            ))}
            <View class="mt-auto">
              <SettingsButton tone="ghost" label="Sign out" onPress={() => { openPage.set(null); resetAccountState(); void signOutOfConnect(); }} />
            </View>
          </View>
          {page === "mobile-clients" ? <MobileClientsPage /> : page === "t3-chat" ? <T3ChatPage /> : <T3ConnectPage />}
        </View>
      </SettingsDialog>
    );
  };
}
