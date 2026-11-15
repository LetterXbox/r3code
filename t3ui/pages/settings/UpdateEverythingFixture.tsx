import { mount, signal, Text, View } from "nsh";
import { UpdateEverythingDialog } from "./providers/UpdateEverythingDialog";
import type { UpdateEverythingMachine } from "./providers/updateEverything";

const machines = signal<UpdateEverythingMachine[]>([
  { key: "m1", label: "Fixture host", skipped: null, providers: [
    { instanceId: "codex", driver: "codex", name: "Codex", status: "waiting", failure: null },
    { instanceId: "claudeAgent", driver: "claudeAgent", name: "Claude", status: "waiting", failure: null },
  ] },
  { key: "m2", label: "Build box", skipped: "Not connected", providers: [] },
]);
const phase = signal<"confirm" | "running" | "done">("confirm");
const open = signal(true);
const log = signal<string[]>([]);
const set = (instanceId: string, status: "updating" | "done" | "failed", failure: string | null = null) => machines.update((all) => all.map((machine) => ({ ...machine, providers: machine.providers.map((provider) => provider.instanceId === instanceId ? { ...provider, status, failure } : provider) })));

mount(() => <View class="flex-1">
  <View accessibilityLabel="Reopen" onPress={() => { phase.set("confirm"); open.set(true); }}><Text>Reopen</Text></View>
  <View accessibilityLabel="Finish with a failure" onPress={() => { set("codex", "done"); set("claudeAgent", "failed", "npm exited with 1"); phase.set("done"); }}><Text>Finish with a failure</Text></View>
  <Text>{`open ${open()}`}</Text>
  <Each of={log()} key={(line, index) => `${index}:${line}`}>{(line) => <Text>{line()}</Text>}</Each>
  {open() ? <UpdateEverythingDialog machines={machines()} phase={phase()} onClose={() => { log.update((all) => [...all, "closed"]); open.set(false); }}
    onConfirm={() => { log.update((all) => [...all, "confirmed"]); set("codex", "updating"); phase.set("running"); }} /> : null}
</View>);
