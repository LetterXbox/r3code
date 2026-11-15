import { mount, signal, Text, View } from "nsh";
import { FollowScroll, rememberedGroupScroll } from "./TimelineRows";

// A live tool body whose output grows: the open body follows its end while the reader is at the bottom.
const lines = signal(Array.from({ length: 5 }, (_, i) => `line ${i}`));
const followed = signal(0);
const remembered = signal(-1);
mount(() => (
  <View class="w-[400px]">
    <FollowScroll class="max-h-32" live={() => true} onFollow={(y) => followed.set(Math.round(y))}>
      <View>{lines().map((line) => <Text class="h-6">{line}</Text>)}</View>
    </FollowScroll>
    <View accessibilityLabel="More output" onPress={() => lines.update((all) => [...all, ...Array.from({ length: 10 }, (_, i) => `more ${all.length + i}`)])}><Text>more</Text></View>
    <Text>{`followed ${followed() > 0 ? "yes" : "no"}`}</Text>
    <View accessibilityLabel="Group scroll" class="w-[400px]">
      <FollowScroll class="max-h-24" live={() => false} memoryKey="group-1">
        <View>{Array.from({ length: 20 }, (_, i) => <Text class="h-6">{`call ${i}`}</Text>)}</View>
      </FollowScroll>
    </View>
    <View accessibilityLabel="Read memory" onPress={() => remembered.set(rememberedGroupScroll("group-1") ?? -1)}><Text>read</Text></View>
    <Text>{`remembered ${remembered() > 0 ? "yes" : "no"}`}</Text>
  </View>
));
