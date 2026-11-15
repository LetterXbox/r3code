import { mount, signal, Text, View } from "nsh";
import { ContextLabel } from "./ContextLabel";
import { contextStripCompactMode, reportContextStripSpacer, watchContextStrip } from "./contextStripCompact";

const width = signal(700);

function App() {
  watchContextStrip(() => {});
  return (
    <View class="gap-2 p-2">
      <Text onPress={() => width.set(140)}>Narrow</Text>
      <Text onPress={() => width.set(700)}>Wide</Text>
      <Text>{contextStripCompactMode() ? "compact" : "labels"}</Text>
      <View class="flex-row items-center gap-2 px-2" style={{ width: width() }} testID="strip">
        <View class="min-w-0 shrink flex-row items-center gap-1.5"><View class="size-3" /><ContextLabel text={() => "Current checkout"} /></View>
        <View class="min-w-0 flex-1" onLayout={(event) => reportContextStripSpacer(event.bounds.size.width)} />
        <View class="min-w-0 shrink flex-row items-center gap-1.5"><View class="size-3" /><ContextLabel text={() => "feature/context-strip"} /></View>
      </View>
    </View>
  );
}

mount(App);
