// components/clerk/RemoveT3ConnectEnvironmentDialog.tsx: removing a T3 Connect route from this device keeps the account's
// registration, so the confirm says so and points at the account page (the T3 Connect page of the account dialog) to
// deregister. ConnectionsSettings mounts it for a relay environment when the T3 Connect public config is present.
import { signal, Text, View } from "nsh";
import { SettingsButton } from "../components/SettingsLayout";
import { SettingsDialog } from "../components/SettingsDialog";
import { openAccountPage } from "./AccountPages";
import { connectAuthState } from "./connectSession";
import { relayDiscovery, relayEnvironmentRegistration, type RelayEnvironmentRegistration } from "./relayDiscovery";

export const REMOVE_T3_CONNECT_ENVIRONMENT_DESCRIPTION = "This forgets its pairing, credentials, and cached threads here.";

/** The second DialogDescription's text, in the parts it is made of: plain text, or text around the "T3 Connect settings" link. */
export function removeT3ConnectRegistrationCopy(registration: RelayEnvironmentRegistration): { before: string; link: string | null; after: string } {
  if (registration === "registered") return { before: "It stays on your T3 Connect account and keeps its host space. Deregister it in ", link: "T3 Connect settings", after: " to free it." };
  if (registration === "unregistered") return { before: "It's no longer on your T3 Connect account.", link: null, after: "" };
  return { before: "This doesn't change your T3 Connect account. To deregister it there, use ", link: "T3 Connect settings", after: "." };
}

/** The T3 Connect environment awaiting the confirm (the reference's pendingT3ConnectRemoval): its label and relay environment id. */
export interface PendingT3ConnectRemoval { id: string; label: string; relayEnvironmentId: string }
export const pendingT3ConnectRemoval = signal<PendingT3ConnectRemoval | null>(null);

export function RemoveT3ConnectEnvironmentDialog(props: { onConfirm: (environment: PendingT3ConnectRemoval) => void }) {
  // The label and registration the dialog last showed stay while it closes, as the reference's `shown` state keeps them.
  let shown: { label: string | null; registration: RelayEnvironmentRegistration } = { label: null, registration: "unknown" };
  const cancel = () => pendingT3ConnectRemoval.set(null);
  return () => {
    const pending = pendingT3ConnectRemoval();
    const registration = pending ? relayEnvironmentRegistration(relayDiscovery(), pending.relayEnvironmentId) : "unknown";
    if (pending && (pending.label !== shown.label || registration !== shown.registration)) shown = { label: pending.label, registration };
    const copy = removeT3ConnectRegistrationCopy(shown.registration);
    // useT3ConnectAccountPage.open is null until signed in: then the link is plain text.
    const canOpen = connectAuthState().status === "signed-in";
    const link = copy.link === null ? null
      : canOpen
        ? <Text class="text-sm text-muted-foreground underline" accessibilityLabel={copy.link} role="button" onPress={() => { cancel(); openAccountPage(); }}>{copy.link}</Text>
        : <Text class="text-sm text-muted-foreground">{copy.link}</Text>;
    return (
      <SettingsDialog
        open={pending !== null}
        onClose={cancel}
        title={`Remove ${shown.label} from this device?`}
        description={REMOVE_T3_CONNECT_ENVIRONMENT_DESCRIPTION}
        footer={
          <>
            <SettingsButton label="Cancel" onPress={cancel} />
            <SettingsButton label="Remove from this device" tone="destructive" onPress={() => { if (pending) props.onConfirm(pending); }} />
          </>
        }
      >
        <View class="flex-row flex-wrap items-baseline">
          {copy.before ? <Text class="text-sm text-muted-foreground">{copy.before}</Text> : null}
          {link}
          {copy.after ? <Text class="text-sm text-muted-foreground">{copy.after}</Text> : null}
        </View>
      </SettingsDialog>
    );
  };
}
