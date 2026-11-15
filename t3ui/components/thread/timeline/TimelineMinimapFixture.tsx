import { mount, signal, Text, View } from "nsh";
import { TimelineMinimap } from "./TimelineMinimap";
import type { TimelineMinimapItem } from "./minimapLogic";

const items: TimelineMinimapItem[] = Array.from({ length: 12 }, (_, index) => ({
  id: `user-${index}`,
  rowIndex: index * 3,
  userText: `Question number ${index}`,
  assistantText: index === 6 ? "The **answer** to [five](https://example.com) with `code` and more text" : null,
}));
const picked = signal("none");
const visibleItems = signal(items);
const range = signal<{ start: number; end: number } | null>({ start: 15, end: 17 });
const gutter = signal(48);

function App() {
  return (
    <View class="relative h-full w-full bg-background">
      <Text onPress={() => range.set({ start: 0, end: 2 })}>Top</Text>
      <Text onPress={() => range.set({ start: 16, end: 17 })}>Response</Text>
      <Text onPress={() => gutter.set(12)}>Narrow</Text>
      <Text onPress={() => visibleItems.set([...visibleItems(), { id: "user-new", rowIndex: 40, userText: "New question", assistantText: null }])}>Add message</Text>
      <Text>{`picked:${picked()}`}</Text>
      <TimelineMinimap items={visibleItems} gutter={gutter} range={range} onSelect={(item) => picked.set(item.id)} />
    </View>
  );
}

mount(App);
