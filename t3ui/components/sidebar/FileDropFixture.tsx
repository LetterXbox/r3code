import { mount, signal, Text, View } from "nsh";
import { SidebarThreadRow } from "../SidebarThreadRow";
import { pendingFileDrop } from "./pendingFileDrop";
import type { Thread } from "../../store";

const thread: Thread = { id: "t1", projectId: "p", title: "Drop target", status: "idle", pinned: false, updatedAt: Date.now() };
const opened = signal(0);

function Fixture() {
  return (
    <View class="w-[256px] bg-sidebar p-2">
      <SidebarThreadRow thread={thread} variant="folder" active={false} projectName="Demo" onPress={() => opened.update((n) => n + 1)} />
      <Text>Opened: {opened()}</Text>
      <Text>Waiting files: {pendingFileDrop("t1")?.uris.length ?? 0}</Text>
    </View>
  );
}

mount(Fixture);
