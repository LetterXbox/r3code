// A stepper field with createStepperKeys: the arrows step it while the field is focused.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { createStepperKeys } from "./stepperKeys";

function StepperKeysFixture() {
  const value = signal(5);
  const keys = createStepperKeys(() => value(), (next) => value.set(next), () => ({ min: 1, max: 30 }));
  return (
    <View>
      <Text>{`value=${value()}`}</Text>
      <Input accessibilityLabel="Amount" value={String(value())} onFocus={keys.onFocus} onBlur={keys.onBlur} class="h-8 w-20" />
      <Input accessibilityLabel="Other" value="" class="h-8 w-20" />
    </View>
  );
}
mount(StepperKeysFixture);
