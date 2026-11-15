// A terminal drawer with one terminal, reporting where its actions strip and its terminal row sit.
import { mount, signal, Text, View } from "nsh";
import { TerminalDrawer } from "./TerminalDrawer";
import { overridePanelContext } from "../rightPanel/panelState";

overridePanelContext({ key: "fixture-thread", workspace: { threadId: "thread-1", cwd: "/project" } });
const frames = signal<Record<string, { x: number; y: number; width: number; height: number }>>({});

mount(() => (
  <View class="flex-1 bg-background">
    <Text>{`actions:${JSON.stringify(frames().actions ?? null)}`}</Text>
    <Text>{`terminal:${JSON.stringify(frames().terminal ?? null)}`}</Text>
    <TerminalDrawer
      stateKey="fixture-thread"
      threadId="thread-1"
      cwd="/project"
      request={async () => undefined}
      windowHeight={() => 700}
      onFrame={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))}
    />
  </View>
));
