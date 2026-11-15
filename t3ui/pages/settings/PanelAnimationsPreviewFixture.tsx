import { mount, signal, Text, View } from "nsh";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";

const duration = signal(200);

function App() {
  return (
    <View class="p-4 gap-2">
      <Text onPress={() => duration.set(0)}>Instant</Text>
      <PanelAnimationsPreview durationMs={duration} />
    </View>
  );
}

mount(App);
