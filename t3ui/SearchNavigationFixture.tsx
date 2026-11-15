import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SidebarThreadSearch, selectSidebarSearchResult, type SearchResult } from "./components/SidebarThreadSearch";
import { mergeTimeline } from "./components/thread/timeline";
import { ThreadTimeline } from "./pages/ThreadView";
import { setSidebarThreadQuery, sidebarThreadQuery, type Message } from "./store";

const result: SearchResult = {
  thread: { id: "target", projectId: "project", title: "Matched thread", status: "idle", pinned: false, updatedAt: 0 },
  match: { threadId: "target", projectId: "project", source: "assistant", snippet: "needle at message 12", messageId: "m12" },
};
const search = { results: () => [result], pending: () => false, error: () => "", retry: () => {} };
const scope = signal({ environment: "", generation: 0, threadId: "initial" as string | null });
const rows = signal(mergeTimeline(messages("initial"), []));

function messages(prefix: string): Message[] {
  return Array.from({ length: 80 }, (_, index) => ({
    id: `m${index}`,
    role: "assistant" as const,
    body: index === 12 && prefix === "target" ? "needle at message 12" : `${prefix} message ${index}`,
    order: index + 1,
  }));
}

function select(id: string) {
  scope.set({ environment: "", generation: 0, threadId: id });
  rows.set([]);
  setSidebarThreadQuery("");
  setTimeout(() => rows.set(mergeTimeline(messages(id), [])), 120);
}

function Fixture() {
  return <View class="h-full flex-row">
    <View class="w-[240px]">
      <Input accessibilityLabel="Search threads" value={sidebarThreadQuery()} onChange={(event) => setSidebarThreadQuery(event.value)} onSubmit={() => selectSidebarSearchResult(result, select)} />
      <SidebarThreadSearch search={search} onSelect={select} />
      <Text>Search fixture</Text>
    </View>
    {rows().length ? <ThreadTimeline entries={rows} scope={scope} expandedActivity={() => ({})} onToggleActivity={() => {}} onOpenAttachment={() => {}} /> : <Text>Loading thread</Text>}
  </View>;
}

mount(Fixture);
