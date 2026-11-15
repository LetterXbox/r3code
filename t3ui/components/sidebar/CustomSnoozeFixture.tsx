// The Custom snooze dialog open on its own, with the wake time it resolved to.
import { mount, signal, Text, View } from "nsh";
import { CustomSnoozeDialogHost, requestCustomSnooze } from "./CustomSnoozeDialog";

function CustomSnoozeFixture() {
  const result = signal("pending");
  return (
    <View>
      <Text>{`result=${result()}`}</Text>
      <View role="button" accessibilityLabel="Open" onPress={() => { result.set("pending"); void requestCustomSnooze().then((until) => result.set(until ? `${until} hours=${Math.round((Date.parse(until) - Date.now()) / 3_600_000)}` : "cancelled")); }}><Text>Open</Text></View>
      <CustomSnoozeDialogHost />
    </View>
  );
}
mount(CustomSnoozeFixture);
