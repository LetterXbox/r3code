import { mount, signal, Text, View } from "nsh";
import { DiagnosisPanel } from "./Connection";
import { ToastHost } from "../../components/toast";
import { classifyConnectionFailure, presentConnectionDiagnosis } from "../../environments/connectionDiagnosis";

const copied = signal("");
const retried = signal(0);
const diagnosis = presentConnectionDiagnosis({ hostLabel: "Build box", state: { network: "unknown", phase: "backoff", attempt: 2, lastFailure: classifyConnectionFailure(new Error("fetch failed")), retryAt: null }, via: "direct" })!;
mount(() => (
  <View class="flex-1">
    <DiagnosisPanel hostLabel="Build box" diagnosis={diagnosis} onRetry={() => retried.update((n) => n + 1)} copy={async (text) => { copied.set(text); }} />
    <Text>{`retried ${retried()}`}</Text>
    <Text>{copied().split("\n")[0] ?? ""}</Text>
    <ToastHost />
  </View>
));
