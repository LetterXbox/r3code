// Dragging a Files row onto a registered composer drop target (fileTreeDragMention.ts).
import { mount, signal, Text, View } from "nsh";
import type { ViewRef } from "nsh";
import { FilesPanel } from "./FilesPanel";
import { registerMentionDropTarget } from "./fileTreeDragMention";

const dropped = signal("");
const claimed = signal(false);
async function rpc(method: string, payload: unknown): Promise<unknown> {
  if (method === "projects.listEntries") {
    const dir = (payload as { directoryPath?: string }).directoryPath ?? "";
    return dir === "" ? { entries: [{ path: "src", kind: "directory" }, { path: "readme.md", kind: "file" }], truncated: false } : { entries: [], truncated: false };
  }
  return { entries: [], truncated: false };
}

mount(() => (
  <View class="flex-1 flex-row">
    <View class="w-[300px]"><FilesPanel cwd="/project" projectName="demo" onOpenFile={() => {}} request={rpc} /></View>
    <View
      class="flex-1 bg-card"
      accessibilityLabel="Composer drop"
      ref={(node: ViewRef) => registerMentionDropTarget(node, { setActive: (active) => claimed.set(active), insert: (text) => { dropped.set(text); return true; }, onRejected: () => {} })}
    >
      <Text>{`dropped: ${dropped()}`}</Text>
    </View>
  </View>
));
