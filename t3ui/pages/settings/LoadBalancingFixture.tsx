import { mount, signal, Text, View } from "nsh";
import { LoadBalancingSettings, type LoadBalancingEnvironment } from "./providers/LoadBalancingSettings";
import { clientSettings } from "./providers/clientSettings";

const all: LoadBalancingEnvironment[] = [
  { environmentId: "env-a", label: "This Mac", subtitle: "This machine", kind: "desktop" },
  { environmentId: "env-b", label: "Build box", subtitle: "SSH build@box", kind: "server" },
];
const count = signal(2);

mount(() => <View class="flex-1 gap-4 p-4">
  <View accessibilityLabel="One environment" onPress={() => count.set(1)}><Text>One environment</Text></View>
  <LoadBalancingSettings environments={all.slice(0, count())} />
  <Text testID="stored">{JSON.stringify(clientSettings())}</Text>
</View>);
