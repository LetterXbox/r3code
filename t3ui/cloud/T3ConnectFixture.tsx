// Headless fixture: the T3 Connect rows (with a faked relay), the onboarding dialog forced open, and the Welcome phone band.
import { mount, Text, View } from "nsh";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { setRelayDiscoveryFetchForTest } from "./relayDiscovery";
import { ConnectOnboardingDialogHost, connectOnboardingMachineForTest } from "./ConnectOnboardingDialog";
import { PhoneSection } from "../components/onboarding/PhoneSection";
import { beginConnectSignIn, resetConnectSessionForTest } from "./connectSession";

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/u, "");
resetConnectSessionForTest();
const request = await beginConnectSignIn((async () => ({ ok: true, status: 200, json: async () => ({ access_token: "fake", refresh_token: "r", expires_in: 3600, id_token: `${b64({})}.${b64({ sub: "u1" })}.x` }) })) as any);
await request.finish("c");

const env = (id: string) => ({ environmentId: id, label: `Box ${id}`, endpoint: { httpBaseUrl: `https://${id}.t3.codes`, wsBaseUrl: `wss://${id}.t3.codes`, providerKind: "cloudflare_tunnel" }, linkedAt: "x" });
setRelayDiscoveryFetchForTest(async () => ({ ok: false, status: 400, json: async () => ({ _tag: "RelayInternalError", reason: "subject rejected" }) }), async () => [env("a"), env("b")]);

mount(() => (
  <View class="flex-1 gap-2">
    <CloudEnvironmentConnectRows primaryEnvironmentId={null} savedEnvironments={() => [{ environmentId: "b", relayManaged: false, connection: { phase: "available", error: null } }]} showSavedEnvironments empty={<Text>empty</Text>} />
    <View accessibilityLabel="open-onboarding" onPress={() => connectOnboardingMachineForTest.openForAccount.set("u1")}><Text>open-onboarding</Text></View>
    <PhoneSection />
    <ConnectOnboardingDialogHost />
  </View>
));
