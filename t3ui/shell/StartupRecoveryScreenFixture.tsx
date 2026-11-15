import { mount, signal, Text, View } from "nsh";
import { StartupRecoveryHost } from "./StartupRecoveryScreen";
import { presentStartupRecovery } from "../desktop/startupRecovery";

const retries = signal(0);

presentStartupRecovery({ kind: "managed-policy", message: "it is not valid JSON or does not match the policy schema" });

mount(() => (
  <View class="relative flex-1">
    <Text>{`retries ${retries()}`}</Text>
    <StartupRecoveryHost onRetry={() => retries.update((n) => n + 1)} />
  </View>
));
