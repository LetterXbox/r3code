import { mount, signal, Text, View } from "nsh";
import { ComposerPrimaryActions, primaryKind } from "./ComposerPrimaryActions";
import { resolveSendIntent, sendWithSteerFallback, submitLabel } from "./runState";

// The composer's send path over a fake server that, like the real one, refuses a steer unless the run is running.
const status = signal<string | null>("starting");
const log = signal("none");
const error = signal("");
const queued = signal(0);

function Fixture() {
  const running = () => status() === "running";
  const mode = () => resolveSendIntent({ runStatus: status(), alternateModifier: false, activeTurnDefault: "steer" });
  const kind = () => primaryKind({ canInterrupt: false, hasSendableContent: true, editingQueued: false, canResume: false, mode: mode() });
  const server = async (sent: string) => {
    log.set(`sent:${sent}`);
    if (sent === "steer" && status() !== "running") throw Object.assign(new Error("Failed to dispatch"), { tag: "OrchestrationV2DispatchCommandError" });
    if (sent === "queue" || (sent === "auto" && status() !== null)) queued.set(queued() + 1);
  };
  return (
    <View>
      <ComposerPrimaryActions
        kind={kind}
        label={() => submitLabel({ showResume: false, editingQueued: false, running: running(), mode: mode() })}
        tooltip={() => ""}
        disabled={() => false}
        busy={() => false}
        onInterrupt={() => {}}
        onResume={() => {}}
        onSubmit={() => { error.set(""); void sendWithSteerFallback(server, mode()).catch((cause) => error.set(String(cause))); }}
      />
      <Text>{`log:${log()}`}</Text>
      <Text>{`queued:${queued()}`}</Text>
      <Text>{`error:${error() || "none"}`}</Text>
      <View accessibilityLabel="run running" onPress={() => status.set("running")}><Text>run running</Text></View>
    </View>
  );
}
mount(Fixture);
