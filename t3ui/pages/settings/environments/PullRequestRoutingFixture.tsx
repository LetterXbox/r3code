import { mount, signal, Text, View } from "nsh";
import { ToastHost } from "../../../components/toast";
import { PullRequestRoutingSettings, pullRequestRoutingPermissions, type PullRequestRoutingEnvironment } from "./PullRequestRoutingSettings";

const all: PullRequestRoutingEnvironment[] = [
  { environmentId: "ws://127.0.0.1:3773/ws", label: "This Mac", subtitle: "This machine", kind: "desktop", urls: ["ws://127.0.0.1:3773/ws"] },
  { environmentId: "wss://box.example/ws", label: "Build box", subtitle: "Build box", kind: "server", urls: ["wss://box.example/ws"] },
  { environmentId: "bad", label: "No endpoint", subtitle: "No endpoint", kind: "server", urls: [] },
];
const count = signal(3);
const fail = signal(false);

mount(() => <View class="flex-1 gap-4 p-4">
  <View accessibilityLabel="One environment" onPress={() => count.set(1)}><Text>One environment</Text></View>
  <View accessibilityLabel="Fail writes" onPress={() => fail.set(true)}><Text>Fail writes</Text></View>
  <PullRequestRoutingSettings environments={all.slice(0, count())} write={async () => { if (fail()) throw new Error("disk"); }} />
  <Text testID="stored">{JSON.stringify(pullRequestRoutingPermissions())}</Text>
  <ToastHost />
</View>);
