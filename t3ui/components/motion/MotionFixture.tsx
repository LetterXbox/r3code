import { mount, signal, Text, View } from "nsh";
import { createPresence, MotionEnter, MotionLoop } from "./Motion";
import { popoverEnter, statusPulse } from "./motionTokens";

const open = signal(true);
const duration = signal(200);

function App() {
  const presence = createPresence(open, duration);
  return (
    <View class="p-2">
      <Text onPress={() => open.set(!open())}>Toggle</Text>
      <Text onPress={() => duration.set(0)}>Instant</Text>
      {presence.present() ? (
        <MotionEnter spec={popoverEnter} testID="panel">
          <Text>{presence.closing() ? "Closing" : "Open"}</Text>
        </MotionEnter>
      ) : <Text>Gone</Text>}
      <MotionLoop spec={statusPulse}><Text>Pulsing</Text></MotionLoop>
    </View>
  );
}

mount(App);
