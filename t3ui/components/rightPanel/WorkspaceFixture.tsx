// A thread header, chat column, bottom terminal drawer and right panel wired the way
// ThreadView wires them, over a made-up server thread (no server behind it).
import { mount, signal, Text, View, windowSize } from "nsh";
import { Input } from "nsh/base";
import { ThreadHeader } from "../header/ThreadHeader";
import { ToastHost } from "../toast";
import { TerminalDrawer } from "../terminal/TerminalDrawer";
import { terminalCloseAction, terminalNewAction, terminalSplitAction, terminalSplitVerticalAction } from "../terminal/terminalCommands";
import { registerCommand } from "../../commands/registry";
import { RightPanel } from "./RightPanel";
import { overridePreviewScope } from "./previewScope";
import { closeActiveSurfaceAction, currentPanelKey, overridePanelContext, panelStateFor } from "./panelState";

overridePreviewScope("granted");
overridePanelContext({ key: "fixture-thread", workspace: { threadId: "thread-1", cwd: "/project" } });

const log = signal<string[]>([]);
registerCommand("chat.find", () => { log.update((all) => [...all, "chat.find"]); });
const title = signal("Fix the build");
const width = signal(0);
const shareOpen = signal(true);
const drawerHeight = signal(0);
const draft = signal("");
const tree: Record<string, unknown> = {
  "": { entries: [{ path: "src", kind: "directory" }, { path: "readme.md", kind: "file" }], truncated: false },
  src: { entries: [{ path: "src/main.ts", kind: "file" }], truncated: false },
};
async function rpc(method: string, payload: unknown): Promise<unknown> {
  const body = payload as Record<string, string | undefined>;
  log.update((all) => [...all, `${method}:${body.directoryPath ?? body.relativePath ?? body.terminalId ?? ""}`]);
  if (method === "projects.listEntries") return tree[body.directoryPath ?? ""] ?? { entries: [], truncated: false };
  if (method === "projects.readFile") return { relativePath: body.relativePath, contents: "hello\n", byteLength: 6, truncated: false };
  if (method === "review.getDiffPreview") return { sources: [{ kind: body.sourceKind, title: "Changes", baseRef: "main", headRef: "work", diff: "", files: [{ path: "a.ts", previousPath: null, additions: 2, deletions: 1 }], truncated: false }] };
  return undefined;
}

mount(() => (
  <View class="flex-1 bg-background">
    <ToastHost />
    <ThreadHeader
      thread={() => ({ id: "thread-1", title: title(), status: "idle", pinned: false, relations: { parentThreadId: "parent-1", linkOrigin: "Work Mac", guestShare: shareOpen() ? { id: "share-1", guestName: "Ada", expiresAt: "2999-01-01T00:00:00Z" } : null } })}
      parentTitle={() => "Plan the work"}
      onOpenThread={(id) => log.update((all) => [...all, `open-thread:${id}`])}
      onStopGuestShare={(id) => { shareOpen.set(false); log.update((all) => [...all, `stop-share:${id}`]); }}
      project={() => ({ id: "project-1", name: "demo", path: "/project" })}
      isServer={() => true}
      onRename={(_id, next) => { title.set(next); log.update((all) => [...all, `rename:${next}`]); }}
      onNewThread={(id) => log.update((all) => [...all, `new-thread:${id}`])}
    />
    <View class="min-h-0 flex-1 flex-row">
      <View class={panelStateFor(currentPanelKey()).maximized ? "hidden" : "min-w-0 flex-1"}>
        <Text>{`log: ${log().join(" | ")}`}</Text>
        <Text>{`panel-width:${width()}`}</Text>
        <Text>{`draft:${draft()}`}</Text>
        <View accessibilityLabel="Run rightPanel.close" role="button" onPress={closeActiveSurfaceAction}><Text>cmd-close-surface</Text></View>
        <View accessibilityLabel="Deny preview scope" role="button" onPress={() => overridePreviewScope("denied")}><Text>cmd-deny-preview</Text></View>
        <View accessibilityLabel="Run terminal.split" role="button" onPress={terminalSplitAction}><Text>cmd-split</Text></View>
        <View accessibilityLabel="Run terminal.splitVertical" role="button" onPress={terminalSplitVerticalAction}><Text>cmd-split-v</Text></View>
        <View accessibilityLabel="Run terminal.new" role="button" onPress={terminalNewAction}><Text>cmd-new</Text></View>
        <View accessibilityLabel="Run terminal.close" role="button" onPress={() => terminalCloseAction(rpc)}><Text>cmd-close</Text></View>
        <Text>{`drawer-height:${drawerHeight()}`}</Text>
        <View class="flex-1" />
        <Input accessibilityLabel="Composer draft" onChange={(event) => draft.set(event.value)} class="mx-3 h-9 rounded-lg border border-input px-3" />
        {panelStateFor(currentPanelKey()).terminalOpen ? <TerminalDrawer stateKey="fixture-thread" threadId="thread-1" cwd="/project" request={rpc} windowHeight={() => windowSize().height} onHeight={(value) => drawerHeight.set(value)} /> : null}
      </View>
      <RightPanel onWidth={(value) => width.set(value)} request={rpc} windowWidth={() => windowSize().width} rowWidth={() => windowSize().width} />
    </View>
  </View>
));
