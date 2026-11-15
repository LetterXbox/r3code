import { mount, signal, View } from "nsh";
import { LinkRequestCard } from "./LinkRequestCard";
import { linkRequestFromTurnItem } from "./linkRequest";
import { overrideSessionScope } from "../../../backend/sessionScopes";

// A pending link_request turn item (orchestrationV2.ts) where the agent left the machine to the user.
const wire = signal<Record<string, unknown>>({ id: "lr-1", threadId: "t1", type: "link_request", status: "waiting", reason: "I need the build box.", linkStatus: "pending" });
const calls = signal<string[]>([]);
const send = async (method: string, payload: unknown) => {
  if (method === "peerLinks.answerRequest") calls.update((all) => [...all, `${method}:${JSON.stringify(payload)}`]);
  return method === "peerLinks.list" ? { links: [] } : null;
};

function Fixture() {
  return (
    <View>
      <LinkRequestCard item={() => linkRequestFromTurnItem(wire())!} send={send} />
      <View accessibilityLabel={calls().join("|")} class="size-4" />
      <View accessibilityLabel="Deny access write" role="button" class="size-4" onPress={() => overrideSessionScope("access:write", "denied")} />
      <View accessibilityLabel="Mark linked" role="button" class="size-4" onPress={() => wire.update((item) => ({ ...item, linkStatus: "linked", linkedLabel: "build box", linkedAccess: "approval-required" }))} />
    </View>
  );
}

mount(Fixture);
