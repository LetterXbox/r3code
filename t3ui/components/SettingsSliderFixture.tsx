import { mount, signal, Text, View } from "nsh";
import { SettingsSlider } from "./SettingsLayout";

const value = signal(100);
mount(() => <View class="flex-1 p-8">
  <Text>{`value:${value()}`}</Text>
  <SettingsSlider label="Contrast" value={value()} min={50} max={200} step={5} unit="%" onChange={(next) => value.set(next)} />
</View>);
