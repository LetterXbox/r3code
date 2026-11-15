import { mount, signal, Text, View } from "nsh";
import { ThreadFindBar } from "./ThreadFindBar";
import { closeThreadFind, openThreadFind, threadFindFocusRequest, threadFindOpen, threadFindQuery } from "./threadFindState";
import { createServerThreadFind } from "./threadFindServer";

// orchestration.searchThread as the server answers (OrchestrationV2SearchThreadResult); "boom" fails once, then answers.
const calls = signal<string[]>([]);
let failures = 1;
const request = (_method: string, payload: unknown) => {
  const input = payload as { query: string; start?: { entryId: string }; offset?: number };
  calls.update((all) => [...all, `${input.query}|${input.start?.entryId ?? ""}|${input.offset ?? 0}`]);
  if (input.query === "boom" && failures-- > 0) return Promise.reject(new Error("down"));
  const index = ((input.offset ?? 0) + 3) % 3;
  return Promise.resolve({ snapshotSequence: 1, totalMatches: 3, activeIndex: index, match: { entryId: `m${index}`, runId: null, occurrence: 0 } });
};
const find = createServerThreadFind({ request, debounceMs: 10 });

mount(() => (
  <View class="flex-1">
    <ThreadFindBar
      open={threadFindOpen}
      query={threadFindQuery}
      matchCount={() => find.result()?.totalMatches ?? 0}
      activeIndex={() => find.result()?.activeIndex ?? 0}
      focusRequest={threadFindFocusRequest}
      status={find.status}
      counting={() => find.result()?.complete === false}
      onRetry={() => find.retry()}
      onQueryChange={(query) => { threadFindQuery.set(query); find.search("t1", query, { entryId: "m0", occurrence: 0 }); }}
      onNext={() => find.step("t1", threadFindQuery(), 1)}
      onPrevious={() => find.step("t1", threadFindQuery(), -1)}
      onClose={closeThreadFind}
    />
    <View accessibilityLabel="Open find" onPress={openThreadFind}><Text>open</Text></View>
    <Text>{`calls ${calls().join(",")}`}</Text>
  </View>
));
