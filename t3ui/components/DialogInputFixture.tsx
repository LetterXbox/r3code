// DialogInput: a pressable box around the field moves the focus into it, and the field still follows its value.
import { mount, signal, Text, View } from "nsh";
import { DialogInput } from "./DialogInput";

function DialogInputFixture() {
  const value = signal("");
  const focused = signal(false);
  return (
    <View>
      <Text>{`value=[${value()}] focused=${focused()}`}</Text>
      <DialogInput accessibilityLabel="Name" value={value()} onChange={(e: { value: string }) => value.set(e.value)} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)} class="h-8 flex-1" />
      <View role="button" accessibilityLabel="Fill" onPress={() => value.set("from server")}><Text>Fill</Text></View>
    </View>
  );
}
mount(DialogInputFixture);
