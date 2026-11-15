import { mount, signal, Text, View } from "nsh";
import { SidebarThreadSearch } from "../SidebarThreadSearch";
import { setSidebarThreadQuery } from "../../store";

setSidebarThreadQuery("sidebar");
const pending = signal(true);
const withResult = signal(false);
const thread = { id: "one", projectId: "p", title: "Alpha one", status: "idle" as const, pinned: false, updatedAt: 0 };

mount(() => (
  <View class="w-[320px] bg-sidebar">
    <View role="button" accessibilityLabel="Finish" onPress={() => pending.set(false)}><Text>Finish</Text></View>
    <View role="button" accessibilityLabel="Result" onPress={() => withResult.set(true)}><Text>Result</Text></View>
    <SidebarThreadSearch
      onSelect={() => {}}
      search={{
        pending: () => pending(),
        error: () => "",
        retry: () => {},
        results: () => (withResult() ? [{ thread, match: { threadId: "one", projectId: "p", source: "user" as const, snippet: "Fixed the sidebar", messageId: null } }] : []),
      }}
    />
  </View>
));
