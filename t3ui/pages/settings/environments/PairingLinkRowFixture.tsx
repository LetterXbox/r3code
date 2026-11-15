import { mount, signal, Text, View } from "nsh";
import { PairingLinkRow, ConnectedClientRow } from "./PairingLinkRow";
import type { AdvertisedEndpoint } from "./connectionsLogic";

const now = Date.parse("2026-01-01T00:00:00Z");
const link = { id: "l1", label: "iPad", scopes: ["orchestration:read", "terminal:read"], createdAt: "2025-12-31T23:50:00Z", expiresAt: "2026-01-01T00:55:00Z" };
const endpoint = (id: string, over: Partial<AdvertisedEndpoint>): AdvertisedEndpoint => ({
  id, label: id, provider: { id: "desktop-core" }, httpBaseUrl: "http://192.168.1.5:3773", reachability: "lan",
  compatibility: { hostedHttpsApp: "mixed-content-blocked" }, status: "available", ...over,
});
const twoEndpoints = [
  endpoint("desktop-loopback:1", { label: "This machine", reachability: "loopback", httpBaseUrl: "http://127.0.0.1:3773" }),
  endpoint("desktop-lan:1", { label: "Local network" }),
];
const revoked = signal(0);

mount(() => (
  <View class="flex-1 gap-3">
    <Text>{`revoked ${revoked()}`}</Text>
    <PairingLinkRow link={link} credential="CODE1" defaultShareOpen={false} currentOrigin="http://10.0.0.9:3773" endpoints={[]} defaultEndpointKey={null} now={now} revoking={false} canRevoke={true} onRevoke={() => revoked.update((n) => n + 1)} />
    <PairingLinkRow link={{ ...link, id: "l2", label: "Phone" }} credential="CODE2" defaultShareOpen={true} currentOrigin={null} endpoints={twoEndpoints} defaultEndpointKey={null} now={now} revoking={false} canRevoke={true} onRevoke={() => {}} />
    <PairingLinkRow link={{ ...link, id: "l3", label: "Loopback only" }} credential="CODE3" defaultShareOpen={false} currentOrigin="http://localhost:52689" endpoints={[]} defaultEndpointKey={null} now={now} revoking={false} canRevoke={true} onRevoke={() => {}} />
    <PairingLinkRow link={{ ...link, id: "l4", label: "Old link" }} credential={undefined} defaultShareOpen={false} currentOrigin={null} endpoints={[]} defaultEndpointKey={null} now={now} revoking={false} canRevoke={false} onRevoke={() => {}} />
    <ConnectedClientRow session={{ sessionId: "s1", subject: "sub", scopes: ["a", "b", "c"], issuedAt: "2025-12-31T00:00:00Z", lastConnectedAt: "2025-12-31T23:00:00Z", connected: true, current: false, client: { deviceType: "mobile", os: "iOS", browser: "Safari", ipAddress: "10.0.0.4" } }} now={now} revoking={false} canRevoke={true} onRevoke={() => {}} />
  </View>
));
