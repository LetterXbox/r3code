import { mount, signal, Text, View } from "nsh";
import { createPillSwap } from "../sidebar/providerPillSwap";

const view = signal<{ key: string; title: string } | null>({ key: "a", title: "View A" });

function App() {
  const swap = createPillSwap(() => view(), 120);
  return (
    <View class="p-2">
      <Text onPress={() => view.set({ key: "a", title: "View A2" })}>Same key</Text>
      <Text onPress={() => view.set({ key: "b", title: "View B" })}>Other key</Text>
      <Text onPress={() => view.set(null)}>Clear</Text>
      <Text>{swap.shown() ? `${swap.shown()!.title}${swap.leaving() ? " (leaving)" : ""}` : "nothing"}</Text>
    </View>
  );
}

mount(App);
