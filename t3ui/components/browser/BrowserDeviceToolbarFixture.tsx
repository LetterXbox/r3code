// The device toolbar alone, with the committed viewport and ratio shown as a text line.
import { mount, signal, Text, View } from "nsh";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import type { ViewportSetting } from "./viewportLogic";

type Sized = Exclude<ViewportSetting, { kind: "fill" }>;
const setting = signal<Sized>({ kind: "freeform", width: 600, height: 300 });
const ratio = signal<number | null>(null);
const width = signal(800);
const commits = signal(0);

function Fixture() {
  return (
    <View class="flex-1 bg-background">
      <BrowserDeviceToolbar setting={setting} ratio={ratio} width={width} onChange={(next, r) => { if (next.kind !== "fill") setting.set(next); ratio.set(r); commits.set(commits() + 1); }} onClose={() => {}} />
      <Text>{`committed ${setting().width}x${setting().height} ratio ${ratio() === null ? "none" : ratio()!.toFixed(2)} commits ${commits()}`}</Text>
      <View role="button" accessibilityLabel="Narrow" onPress={() => width.set(400)}><Text>Narrow</Text></View>
    </View>
  );
}

mount(Fixture);
