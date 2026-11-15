import { mount, signal, Text, View } from "nsh";
import { ConfirmDialogHost, ToastHost } from "../../../components/toast";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironments";

const day = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
let links = [
  { environmentId: "vps", label: "VPS", urls: ["https://vps.example.ts.net"], access: "full-access", linkedAt: iso(-day), expiresAt: iso(30 * day), lastReachedAt: null, lastError: null, status: "reachable" },
  { environmentId: "soon", label: "Soon", urls: ["https://soon.example"], access: "read-only", linkedAt: iso(-day), expiresAt: iso(2 * day - 1000), lastReachedAt: null, lastError: null, status: "reachable" },
  { environmentId: "old", label: "Old box", urls: ["https://old.example"], access: "approval-required", linkedAt: iso(-day), expiresAt: iso(-day), lastReachedAt: null, lastError: null, status: "expired" },
  { environmentId: "down", label: "Down", urls: ["https://down.example"], access: "auto", linkedAt: iso(-day), expiresAt: iso(30 * day), lastReachedAt: null, lastError: null, status: "unreachable" },
];
const calls = signal<string[]>([]);
const request = async (method: string, payload: unknown) => {
  calls.update((all) => [...all, `${method} ${JSON.stringify(payload)}`]);
  if (method === "peerLinks.list") return { links };
  if (method === "peerLinks.unlink") {
    const id = (payload as { environmentId: string }).environmentId;
    links = links.filter((link) => link.environmentId !== id);
    return { removed: true };
  }
  if (method === "peerLinks.link") {
    if ((payload as { pairingCode: string }).pairingCode === "BAD") throw new Error("The pairing code was rejected.");
    return { ...links[0], environmentId: "new", label: "New box" };
  }
  throw new Error(method);
};

mount(() => (
  <View class="flex-1 gap-3 p-4">
    <LinkedEnvironmentsSettings request={request} />
    <LinkedEnvironmentsSettings request={async () => { throw new Error("Environment unreachable"); }} environmentLabel="Laptop" />
    <LinkedEnvironmentsSettings request={async () => ({ links: [] })} environmentLabel="Empty" />
    <Text>{calls().join("\n")}</Text>
    <ConfirmDialogHost />
    <ToastHost />
  </View>
));
