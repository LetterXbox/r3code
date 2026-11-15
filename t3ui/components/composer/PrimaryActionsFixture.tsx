import { mount, signal, Text, View } from "nsh";
import { ComposerPrimaryActions, primaryKind } from "./ComposerPrimaryActions";
import { submitLabel } from "./runState";

const running = signal(true);
const content = signal(false);
const held = signal(false);
const editing = signal(false);
const mode = signal<"auto" | "queue" | "steer">("steer");
const log = signal("none");
const keep = signal(false);
const compact = signal<string | null>(null);
const canOperate = signal(true);

function Fixture() {
  const kind = () => primaryKind({ canInterrupt: running(), hasSendableContent: content(), editingQueued: editing(), canResume: held(), mode: running() ? mode() : "auto" });
  return (
    <View>
      <ComposerPrimaryActions
        kind={kind}
        label={() => submitLabel({ showResume: kind() === "resume", editingQueued: editing(), running: running(), mode: running() ? mode() : "auto" })}
        tooltip={() => ""}
        disabled={() => false}
        busy={() => false}
        onInterrupt={() => log.set("interrupt")}
        onResume={() => log.set("resume")}
        onSubmit={(alternate) => log.set(alternate ? "alternate" : "submit")}
        compactTokens={compact}
        keepFullHistory={keep}
        canOperate={canOperate}
        onToggleKeepFullHistory={() => keep.set(!keep())}
      />
      <Text>{`log:${log()}`}</Text>
      <View accessibilityLabel="disconnect" onPress={() => canOperate.set(false)}><Text>disconnect</Text></View>
      <View accessibilityLabel="has content" onPress={() => content.set(true)}><Text>has content</Text></View>
      <View accessibilityLabel="queue mode" onPress={() => mode.set("queue")}><Text>queue mode</Text></View>
      <View accessibilityLabel="stale" onPress={() => compact.set("212k")}><Text>stale</Text></View>
      <View accessibilityLabel="idle" onPress={() => { running.set(false); content.set(false); }}><Text>idle</Text></View>
      <View accessibilityLabel="held" onPress={() => held.set(true)}><Text>held</Text></View>
      <View accessibilityLabel="edit" onPress={() => { editing.set(true); content.set(true); }}><Text>edit</Text></View>
    </View>
  );
}
mount(Fixture);
