import { mount, signal, Text, View } from "nsh";
import { ThreadFindBar } from "./ThreadFindBar";
import { closeThreadFind, openThreadFind, threadFindActiveIndex, threadFindFocusRequest, threadFindOpen, threadFindQuery } from "./threadFindState";
import { findThreadMatches, stepThreadFindIndex } from "./threadFind";

const entries = [{ id: "a", text: "alpha beta alpha" }, { id: "b", text: "gamma" }, { id: "c", text: "Alpha again" }];
const matches = () => findThreadMatches(entries, threadFindQuery());
const log = signal("");

function Fixture() {
  return (
    <View class="flex-1">
      <ThreadFindBar
        open={threadFindOpen}
        query={threadFindQuery}
        matchCount={() => matches().length}
        activeIndex={threadFindActiveIndex}
        focusRequest={threadFindFocusRequest}
        onQueryChange={(query) => { threadFindQuery.set(query); threadFindActiveIndex.set(0); }}
        onNext={() => { threadFindActiveIndex.set(stepThreadFindIndex(threadFindActiveIndex(), matches().length, 1)); log.set(matches()[threadFindActiveIndex()]?.entryId ?? ""); }}
        onPrevious={() => { threadFindActiveIndex.set(stepThreadFindIndex(threadFindActiveIndex(), matches().length, -1)); log.set(matches()[threadFindActiveIndex()]?.entryId ?? ""); }}
        onClose={closeThreadFind}
      />
      <View accessibilityLabel="Open find" onPress={openThreadFind}><Text>open</Text></View>
      <Text>{`active:${log()}`}</Text>
    </View>
  );
}

mount(Fixture);
