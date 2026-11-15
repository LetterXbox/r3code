// WelcomePage's PhoneSection: "Use T3 Code on your phone" with Set up / Hide, a QR code for the store link, and the steps; step 2 is
// PhoneConnectLink, which follows the T3 Connect sign-in and this computer's link state. Mounted only where welcomeOffersPhone says so.
import { effect, signal, Text, View } from "nsh";
import { Icon } from "../Icons";
import { SettingsIcon } from "../../pages/settings/SettingsIcon";
import { QrCodeView } from "../QrCodeView";
import { openSettings } from "../../store";
import { MOBILE_APP_URL } from "./phoneOffer";
import { connectAuthState } from "../../cloud/connectSession";
import { openConnectSignIn } from "../../cloud/ConnectSignIn";
import { primaryCloudLink, refreshPrimaryCloudLink } from "../../cloud/primaryCloudLink";

const open = signal(false);

export type PhoneConnectState =
  | { kind: "checking" } | { kind: "check-failed" } | { kind: "reachable" } | { kind: "on" }
  | { kind: "signed-in"; shared: boolean } | { kind: "signed-out"; loaded: boolean };

/** PhoneConnectLink's branches, in the reference's order. */
export function resolvePhoneConnect(input: {
  auth: "loading" | "signed-in" | "signed-out";
  userId: string | null;
  link: { linked: boolean; linkRevoked?: boolean; cloudUserId: string | null; managedTunnelActive?: boolean; reachability?: { status: string } } | null;
  linkError: string | null;
  linkPending: boolean;
}): PhoneConnectState {
  const signedIn = input.auth === "signed-in";
  const link = input.link;
  // The phone reaches this computer through its tunnel; older servers leave that flag out.
  const shared = link !== null && link.linked && link.linkRevoked !== true && link.cloudUserId === input.userId && link.managedTunnelActive !== false;
  const reachability = shared ? link!.reachability?.status : undefined;
  if (signedIn && link === null && input.linkPending) return { kind: "checking" };
  if (signedIn && input.linkError !== null) return { kind: "check-failed" };
  if (signedIn && reachability === "reachable") return { kind: "reachable" };
  if (signedIn && shared && reachability === undefined) return { kind: "on" };
  if (signedIn) return { kind: "signed-in", shared };
  return { kind: "signed-out", loaded: input.auth !== "loading" };
}

function SmallButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <View role="button" accessibilityLabel={props.label} disabled={props.disabled === true} onPress={props.onPress} class={`h-6 items-center justify-center rounded-lg border border-input bg-popover px-2 ${props.disabled ? "opacity-64" : ""}`}>
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
    </View>
  );
}

function PhoneConnectLink() {
  void refreshPrimaryCloudLink();
  // The server rechecks the tunnel every 30 s; read its latest result while this panel is open.
  effect(() => {
    const interval = setInterval(() => void refreshPrimaryCloudLink(), 30_000);
    return () => clearInterval(interval);
  });
  const state = () => {
    const auth = connectAuthState();
    return resolvePhoneConnect({
      auth: auth.status, userId: auth.status === "signed-in" ? auth.userId : null,
      link: primaryCloudLink.data(), linkError: primaryCloudLink.error(), linkPending: primaryCloudLink.pending(),
    });
  };
  const settingsLink = (label: string) => <SmallButton label={label} onPress={() => openSettings("/settings/access")} />;
  return (
    <View class="items-start gap-2">
      {(() => {
        const current = state();
        switch (current.kind) {
          case "checking": return <Text class="text-sm text-muted-foreground">Checking T3 Connect…</Text>;
          case "check-failed": return <><Text class="text-sm text-foreground">Could not check T3 Connect.</Text>{settingsLink("Check T3 Connect")}</>;
          case "reachable": return (
            <View class="flex-row gap-1.5"><SettingsIcon name="check" size={16} /><Text class="text-sm text-foreground">Your phone can reach this computer. Sign in to the app with the same account.</Text></View>
          );
          case "on": return <Text class="text-sm text-foreground">T3 Connect is on for this computer. Sign in to the app with the same account.</Text>;
          case "signed-in": return (
            <>
              <Text class="text-sm text-foreground">{current.shared ? "T3 Connect is on, but the app cannot reach this computer." : "Signed in. Share this computer so the app can reach it."}</Text>
              {settingsLink(current.shared ? "Check T3 Connect" : "Set up T3 Connect")}
            </>
          );
          case "signed-out": return (
            <>
              <Text class="text-sm text-foreground">Sign in to T3 Connect here, then in the app with the same account.</Text>
              <SmallButton label="Sign in to T3 Connect" disabled={!current.loaded} onPress={() => void openConnectSignIn()} />
            </>
          );
        }
      })()}
    </View>
  );
}

export function PhoneSection() {
  return (
    <View class="flex-row gap-x-10 border-b border-border-60 py-4" accessibilityLabel="Phone">
      <Text class="w-24 shrink-0 text-sm leading-10 text-muted-foreground">Phone</Text>
      <View class="min-w-0 flex-1">
        <View class="min-h-10 flex-row items-center gap-3 py-1">
          <View class="size-5 shrink-0 items-center justify-center"><Icon name="smartphone" size={16} /></View>
          <Text class="min-w-0 flex-1 text-sm font-medium text-foreground">Use R3 Code on your phone</Text>
          <View role="button" accessibilityLabel={open() ? "Hide" : "Set up"} onPress={() => open.set(!open())} class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent">
            <Text class="text-xs font-medium text-muted-foreground">{open() ? "Hide" : "Set up"}</Text>
            <Icon name="chevron-down" size={14} />
          </View>
        </View>
        {open() ? (
          <View class="flex-row items-center gap-8 pb-3 pl-8 pt-2">
            <View class="min-w-0 flex-1 gap-5">
              <View class="flex-row gap-3"><Text class="w-3 shrink-0 text-sm text-muted-foreground">1</Text><Text class="text-sm text-foreground">Scan with your phone to get the app.</Text></View>
              <View class="flex-row gap-3">
                <Text class="w-3 shrink-0 text-sm text-muted-foreground">2</Text>
                <PhoneConnectLink />
              </View>
            </View>
            <QrCodeView value={MOBILE_APP_URL} size={124} marginSize={2} title="R3 Code app for iPhone and Android" />
          </View>
        ) : null}
      </View>
    </View>
  );
}
