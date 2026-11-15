import { mount, signal, View } from "nsh";
import { ActivityRow, type ActivityDisplay } from "./ActivityRow";

const expanded = signal(false);
const item = signal<ActivityDisplay>({
  id: "tool-1", type: "command_execution", title: "Command", detail: "npm test\n\nAll tests passed", status: "completed",
});

function Fixture() {
  return (
    <View>
      <ActivityRow item={item} expanded={expanded} onToggle={() => expanded.update((value) => !value)} />
    </View>
  );
}

mount(Fixture);
