import { mount, Text, View } from "nsh";
import { CommandPalette } from "./components/CommandPalette";
import { openPaletteOnLinkedThreads, setPaletteSearchRequest } from "./components/palette/paletteModel";
import { overridePanelContext } from "./components/rightPanel/panelState";
import { paletteQuery } from "./store";

overridePanelContext({ key: "palette-linked-test", workspace: { threadId: "t1", cwd: "/work/proj" } });
setPaletteSearchRequest(async () => ({ entries: [], matches: [], truncated: false }));
const URL = "https://github.com/acme/widgets/pull/2288";

mount(() => (
  <View class="flex-1">
    <View role="button" accessibilityLabel="Open linked" onPress={() => openPaletteOnLinkedThreads({ query: URL, environmentId: "env-1", threads: [{ id: "lt-1", title: "Port the rail", archivedAt: null }, { id: "lt-2", title: "Old spike", archivedAt: "2026-01-01" }] })}><Text>open</Text></View>
    <View role="button" accessibilityLabel="Open linked on file query" onPress={() => openPaletteOnLinkedThreads({ query: "Go to file", environmentId: "env-1", threads: [{ id: "lt-1", title: "Port the rail", archivedAt: null }] })}><Text>open2</Text></View>
    <Text>{`query=${paletteQuery()}`}</Text>
    <CommandPalette />
  </View>
));
