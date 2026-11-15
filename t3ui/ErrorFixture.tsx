// The root error view: a child that throws when asked, under the same boundary App.tsx uses.
import { mount, signal, Text, View } from "nsh";
import { RootErrorBoundary } from "./shell/RootErrorView";

const broken = signal(false);

function Broken(): never {
  throw new Error("Render failed");
}

function Child() {
  return <View>{broken() ? <Broken /> : <Text>All good</Text>}</View>;
}

mount(() => (
  <View class="flex-1">
    <View role="button" accessibilityLabel="Break" onPress={() => broken.set(true)}><Text>Break</Text></View>
    <View role="button" accessibilityLabel="Mend" onPress={() => broken.set(false)}><Text>Mend</Text></View>
    <RootErrorBoundary><Child /></RootErrorBoundary>
  </View>
));
