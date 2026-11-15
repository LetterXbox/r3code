// The viewport rails around a 400 x 300 frame in a 1000 x 800 room, with the committed setting shown.
import { mount, signal, Text, View } from "nsh";
import { createViewportResize } from "./BrowserViewportResizeHandles";
import type { ViewportSetting } from "./viewportLogic";

function ViewportResizeFixture() {
  const setting = signal<ViewportSetting>({ kind: "preset", width: 400, height: 300, presetId: "x" });
  const resize = createViewportResize({ setting: () => setting(), ratio: () => null, available: () => ({ width: 1000, height: 800 }), onCommit: (size) => setting.set({ kind: "freeform", ...size }) });
  const shown = () => { const value = setting(); return value.kind === "fill" ? "fill" : `${value.kind} ${value.width}x${value.height}`; };
  return (
    <View class="relative h-full w-full">
      <Text>{`setting=${shown()}`}</Text>
      <View role="button" accessibilityLabel="Key left" onPress={() => resize.resizeByKey("west", "left", false)}><Text>Key left</Text></View>
      <View role="button" accessibilityLabel="Key shift left" onPress={() => resize.resizeByKey("west", "left", true)}><Text>Key shift left</Text></View>
      <View role="button" accessibilityLabel="Key up" onPress={() => resize.resizeByKey("west", "up", false)}><Text>Key up</Text></View>
      <Text>{`live=${resize.live() ? `${resize.live()!.width}x${resize.live()!.height}` : "none"}`}</Text>
      <resize.Handles frame={() => ({ x: 100, y: 100, width: 400, height: 300 })} />
    </View>
  );
}
mount(ViewportResizeFixture);
