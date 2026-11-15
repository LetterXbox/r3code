// Two folders (one closed), a leaf, and the Settled shelf, wired to the tree keys.
import { mount, signal, Text, View } from "nsh";
import { SidebarThreadRow } from "../SidebarThreadRow";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { bindTreeKeys, projectRowId, shelfRowId, threadRowId, treeRowProps } from "./sidebarTree";
import type { TreeRow } from "./sidebarTree";
import type { Thread } from "../../store";

const thread = (id: string, title: string): Thread => ({ id, projectId: "p", title, status: "idle", pinned: false, updatedAt: Date.now() });
const open = signal(true);
const shelf = signal(false);
const clicked = signal("none");

const rows = (): TreeRow[] => [
  { id: threadRowId("leaf"), parent: null, expanded: null },
  { id: projectRowId("a"), parent: null, expanded: open() },
  ...(open() ? [
    { id: threadRowId("a1"), parent: projectRowId("a"), expanded: null },
    { id: threadRowId("a2"), parent: projectRowId("a"), expanded: null },
  ] : []),
  { id: shelfRowId("settled"), parent: null, expanded: shelf() },
];

function Folder() {
  const tree = treeRowProps(projectRowId("a"), () => open.update((value) => !value));
  return (
    <View role="button" accessibilityLabel="Folder A" accessibilityState={{ expanded: open() }}
      ref={tree.ref} onFocus={tree.onFocus} onBlur={tree.onBlur} onPress={() => open.update((value) => !value)}>
      <Text>Folder A</Text>
    </View>
  );
}

function Fixture() {
  bindTreeKeys(rows);
  return (
    <View class="w-[300px] bg-sidebar">
      <SidebarThreadRow thread={thread("leaf", "Leaf thread")} variant="slim" active={false} onPress={() => clicked.set("leaf")} />
      <Folder />
      {open() ? <>
        <SidebarThreadRow thread={thread("a1", "Child one")} variant="folder" active={false} onPress={() => clicked.set("a1")} />
        <SidebarThreadRow thread={thread("a2", "Child two")} variant="folder" active={false} onPress={() => clicked.set("a2")} />
      </> : null}
      <SidebarSectionHeader label="Settled" count={0} expanded={shelf()} shelf="settled" onToggle={() => shelf.update((value) => !value)} />
      <Text>Clicked: {clicked()}</Text>
    </View>
  );
}

mount(Fixture);
