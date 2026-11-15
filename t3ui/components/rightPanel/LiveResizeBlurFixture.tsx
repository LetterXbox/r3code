// A live resize driven by hand: start a pan, move the pointer 40 pt, and the committed size shows.
import { mount, signal, Text, View } from "nsh";
import { createLiveResize } from "./liveResize";

function LiveResizeBlurFixture() {
  const committed = signal(400);
  const resize = createLiveResize({ axis: "x", direction: 1, size: () => committed(), clamp: (size) => size, commit: (size) => committed.set(size) });
  const move = (x: number) => resize.follow({ position: { x, y: 0 }, pagePosition: { x, y: 0 }, modifiers: {} as never, pressedButton: "left" as never });
  return (
    <View>
      <Text>{`committed=${committed()} live=${resize.live() ?? "none"}`}</Text>
      <View role="button" accessibilityLabel="Drag" onPress={() => { move(100); resize.handle.onPanStart({ cancelled: false, translation: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } }); move(100); move(140); }}><Text>Drag</Text></View>
    </View>
  );
}
mount(LiveResizeBlurFixture);
