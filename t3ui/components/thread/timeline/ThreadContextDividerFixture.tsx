import { mount, signal, Text, View } from "nsh";
import { ThreadContextDivider } from "./ThreadContextDivider";

const opened = signal(0);
function Fixture() {
  return (
    <View>
      <ThreadContextDivider link={() => ({ title: "Planner", sideChat: true, open: () => opened.update((n) => n + 1) })} />
      <Text>{`opened:${opened()}`}</Text>
    </View>
  );
}
mount(Fixture);
