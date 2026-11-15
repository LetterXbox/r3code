// settledLayout: a branch fed by an object that changes on every update mounts its child once, and again only when it flips.
import { mount, signal, Text, View } from "nsh";
import { settledLayout } from "./PromptEditor";

const mounts = signal(0);

function Child() {
  mounts.update((n) => n + 1);
  return <Text>child</Text>;
}

function SettledLayoutFixture() {
  const thread = signal<{ n: number } | null>({ n: 0 });
  const shown = settledLayout(() => thread() !== null);
  return (
    <View>
      <Text>{`mounts=${mounts()}`}</Text>
      <View role="button" accessibilityLabel="Update" onPress={() => thread.set({ n: (thread()?.n ?? 0) + 1 })}><Text>Update</Text></View>
      <View role="button" accessibilityLabel="Clear" onPress={() => thread.set(null)}><Text>Clear</Text></View>
      {shown() ? <Child /> : <Text>empty</Text>}
    </View>
  );
}
mount(SettledLayoutFixture);
