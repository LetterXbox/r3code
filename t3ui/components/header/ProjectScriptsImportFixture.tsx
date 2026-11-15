// The project actions row over a project that has one script and a t3.json offering three: one already there
// (same command), one with the same name in another case, and one new.
import { mount, signal, Text, View } from "nsh";
import { ConfirmDialogHost } from "../toast";
import { ProjectScriptsRow } from "./ProjectScriptsRow";
import type { ProjectScript } from "./projectScripts";

const log = signal<string[]>([]);
const scripts = signal<ProjectScript[]>([{ id: "test", name: "Test", command: "bun test", icon: "test", runOnWorktreeCreate: false }]);
let failImport = false;

mount(() => (
  <View class="w-[280px]">
    <Text>{log().join("|")}</Text>
    <ConfirmDialogHost />
    <View role="button" accessibilityLabel="Fail the next save" onPress={() => { failImport = true; }}><Text>Fail the next save</Text></View>
    <ProjectScriptsRow
      scripts={scripts}
      onRun={() => {}}
      fileScripts={() => [
        { name: "Another", command: "bun test" },
        { name: "test", command: "bun run unit" },
        { name: "Lint", command: "bun lint", icon: "lint", runOnWorktreeCreate: true, async: false, previewUrl: "http://localhost:3000", autoOpenPreview: true },
      ]}
      requestServer={async (method) => { log.update((all) => [...all, `server:${method}`]); throw new Error("Unable to parse keybindings config at /h/keybindings.json: Unexpected token"); }}
      onSave={async (next) => {
        log.update((all) => [...all, `save:${JSON.stringify(next)}`]);
        if (failImport) { failImport = false; throw new Error("settings are read-only"); }
        scripts.set(next);
      }}
    />
  </View>
));
