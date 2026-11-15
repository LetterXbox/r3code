import { keymap, mount, Text, View } from "nsh";
import { CommandPalette } from "./components/CommandPalette";
import { setPaletteSearchRequest } from "./components/palette/paletteModel";
import { overridePanelContext } from "./components/rightPanel/panelState";
import { togglePalette, usageOpen } from "./store";

overridePanelContext({ key: "palette-test", workspace: { threadId: "t1", cwd: "/work/proj" } });
setPaletteSearchRequest(async (method, payload) => {
  const query = (payload as { query: string }).query;
  if (method === "projects.searchEntries") {
    return { entries: [{ path: "src/app.ts", kind: "file" }, { path: "docs", kind: "directory" }].filter((entry) => entry.path.includes(query)), truncated: false };
  }
  if (method === "projects.searchContents") {
    return { matches: [{ path: "src/app.ts", lineNumber: 7, lineContent: `  const ${query} = 1;`, matchRanges: [] }], truncated: false };
  }
  return { matches: [] };
});

keymap.bind("mod+k", togglePalette);

mount(() => (
  <View class="flex-1">
    {usageOpen() ? <Text>Usage dialog active</Text> : null}
    <CommandPalette />
  </View>
));
