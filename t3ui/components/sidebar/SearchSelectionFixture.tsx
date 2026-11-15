// A search field over three fixed results, wired as the sidebar wires them.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { bindSearchKeys, createSearchHighlight, SidebarThreadSearch } from "../SidebarThreadSearch";
import type { SearchResult } from "../SidebarThreadSearch";
import { setSidebarThreadQuery, sidebarThreadQuery } from "../../store";

const thread = (id: string, title: string) => ({ id, projectId: "p", title, status: "idle" as const, pinned: false, updatedAt: 0 });
const all: SearchResult[] = [
  { thread: thread("one", "Alpha one"), match: null },
  { thread: thread("two", "Alpha two"), match: null },
  { thread: thread("three", "Alpha three"), match: null },
];
const opened = signal("none");

function Fixture() {
  const results = () => (sidebarThreadQuery().trim() ? all : []);
  const highlight = createSearchHighlight(results);
  const focused = signal(false);
  bindSearchKeys(focused, () => results().length > 0, highlight.move);
  const select = (id: string) => {
    opened.set(id);
    setSidebarThreadQuery("");
  };
  const search = { results, pending: () => false, error: () => "", retry: () => {}, ...highlight };
  return (
    <View class="w-[300px] bg-sidebar">
      <Input
        accessibilityLabel="Search threads"
        value={sidebarThreadQuery()}
        onChange={(event) => setSidebarThreadQuery(event.value)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        onSubmit={() => highlight.openHighlighted(select)}
      />
      {sidebarThreadQuery().trim() ? <SidebarThreadSearch search={search} onSelect={select} /> : null}
      <Text>Opened: {opened()}</Text>
    </View>
  );
}

mount(Fixture);
