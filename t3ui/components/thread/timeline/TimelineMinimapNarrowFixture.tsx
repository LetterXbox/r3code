import { mount, signal, Text, View } from "nsh";
import { TimelineMinimap } from "./TimelineMinimap";

const picked = signal("none");
const items = [
  { id: "first", rowIndex: 0, userText: "First message", assistantText: null },
  { id: "second", rowIndex: 2, userText: "Second message", assistantText: null },
];
mount(() => <View class="relative h-full w-full"><Text>{`picked:${picked()}`}</Text><TimelineMinimap items={() => items} gutter={() => 48} range={() => ({ start: 0, end: 1 })} onSelect={(item) => picked.set(item.id)} /></View>);
