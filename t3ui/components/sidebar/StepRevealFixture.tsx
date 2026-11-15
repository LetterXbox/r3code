import { mount, signal, Text, View } from "nsh";
import { createStepReveal } from "./stepReveal";

const dragging = signal(false);

function App() {
  const revealed = createStepReveal(() => dragging());
  return (
    <View class="p-2">
      <Text onPress={() => dragging.set(!dragging())}>Toggle</Text>
      <Text>{revealed() ? "shown" : "hidden"}</Text>
    </View>
  );
}

mount(App);
