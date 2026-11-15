// ProviderWizardAuthenticationStep.tsx: the Sign in step after an ACP Registry instance is created.
import { effect, signal, Text, View } from "nsh";
import type { ProviderAuthState } from "../../../store";
import type { ProviderApi } from "./data";
import { ProviderAuthentication } from "./ProviderAuth";
import { ButtonText, PillButton, Row } from "./ui";

export function ProviderWizardAuthStep(props: { api: ProviderApi; environmentLabel: string; instanceId: string; onFinish: () => void }) {
  const auth = signal<ProviderAuthState | null>(null);
  const error = signal<string | null>(null);
  effect(() => {
    const id = props.instanceId;
    auth.set(null); error.set(null);
    return props.api.setup.subscribeAuth(id, (state) => auth.set(state), (cause) => error.set(cause.message));
  });
  const provider = () => props.api.providers().find((candidate) => candidate.instanceId === props.instanceId);
  const active = () => ["starting", "waiting", "verifying"].includes(auth()?.phase ?? "");
  const signedIn = () => provider()?.auth.status === "authenticated" || (provider()?.auth.status === "unknown" && auth()?.phase === "succeeded");
  const discovering = () => !signedIn() && !error() && auth() === null;
  const canAuthenticate = () => (auth()?.methods.length ?? 0) > 0;
  const docs = () => provider()?.setup.documentationUrl ?? null;
  return <View testID="Provider sign-in step" class="gap-4">
    <View class="min-h-72">
      {provider() && (canAuthenticate() || signedIn())
        ? <ProviderAuthentication divider={false} api={props.api} instanceId={props.instanceId} provider={{ ...(provider() as NonNullable<ReturnType<typeof provider>>), setup: { ...(provider() as NonNullable<ReturnType<typeof provider>>).setup, canAuthenticate: true } }}
          environmentLabel={props.environmentLabel} readOnly={false} />
        : <Row divider={false} title="Account"
          description={discovering() ? "Discovering sign-in methods…" : error() ?? auth()?.message ?? "No in-app sign-in advertised. Follow the provider's docs to finish setup."}
          control={discovering() ? <PillButton label="Sign in" disabled onPress={() => {}}><ButtonText>Sign in</ButtonText></PillButton>
            : docs() ? <PillButton label="Open docs" onPress={() => props.api.openExternal(docs() as string)}><ButtonText>Open docs</ButtonText></PillButton> : null} />}
    </View>
    <View class="flex-row items-center justify-end gap-2">
      <PillButton label={signedIn() ? "Done" : "Skip for now"} variant={signedIn() ? "primary" : "outline"} disabled={active()} onPress={props.onFinish}>
        <ButtonText tone={signedIn() ? "primary" : "default"}>{signedIn() ? "Done" : "Skip for now"}</ButtonText></PillButton>
    </View>
  </View>;
}
