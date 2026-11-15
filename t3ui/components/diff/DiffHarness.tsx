import { mount, signal, Text, View } from "nsh";
import { DiffPanel } from "./DiffPanel";
import { updateSetting } from "../../store";

const cwd = signal<string | null>("/project");
const threadId = signal("thread-1");
const open = signal(true);
let failures = 0;
const holdRefresh = signal(false);
const failRefresh = signal(false);
let releaseRefresh: (() => void) | null = null;

function source(kind: string, diff: string, files: unknown[], truncated = false) {
  return { sources: [{ kind, title: kind === "working-tree" ? "Uncommitted" : "Changes", baseRef: "main", headRef: "feature", diff, files, truncated }] };
}

async function rpc(_method: string, payload: unknown): Promise<unknown> {
  if (typeof payload !== "object" || payload === null || !("cwd" in payload) || !("sourceKind" in payload)) throw new Error("Invalid test request");
  const dir = payload.cwd;
  const kind = payload.sourceKind;
  if (typeof dir !== "string" || typeof kind !== "string") throw new Error("Invalid test request");
  if (dir === "/error" && !("file" in payload) && failures++ === 0) throw new Error("Repository unavailable");
  const ignoreWhitespace = "ignoreWhitespace" in payload && payload.ignoreWhitespace === true;
  const files = !ignoreWhitespace ? [{ path: "whitespace-shown.ts", previousPath: null, additions: 1, deletions: 0 }] : kind === "working-tree" ? [{ path: "uncommitted.txt", previousPath: null, additions: 1, deletions: 0 }] : [
    { path: "src/first.ts", previousPath: null, additions: 2, deletions: 1 },
    { path: "src/second.ts", previousPath: null, additions: 1, deletions: 1 },
    { path: "src/renamed.ts", previousPath: "src/original.ts", additions: 1, deletions: 1 },
  ];
  if (!("file" in payload)) {
    if (holdRefresh()) { holdRefresh.set(false); await new Promise<void>((resolve) => { releaseRefresh = resolve; }); }
    if (failRefresh()) { failRefresh.set(false); throw new Error("Refresh unavailable"); }
    if (dir === "/slow") await new Promise((resolve) => setTimeout(resolve, 400));
    return source(kind, "", files);
  }
  const file = payload.file;
  if (typeof file !== "object" || file === null || !("path" in file) || typeof file.path !== "string") throw new Error("Invalid test file");
  const first = file.path === "src/first.ts";
  if (first) await new Promise((resolve) => setTimeout(resolve, 300));
  return source(kind, `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1 +1 @@\n-old\n+new\n`, files, first);
}

mount(() => <View class="flex-1 flex-row">
  <View class="w-40 gap-3">
    <View accessibilityLabel="Load error" onPress={() => { threadId.set("thread-error"); cwd.set("/error"); }}><Text>Load error</Text></View>
    <View accessibilityLabel="Load slow" onPress={() => { threadId.set("thread-slow"); cwd.set("/slow"); }}><Text>Load slow</Text></View>
    <View accessibilityLabel="Load normal" onPress={() => { threadId.set("thread-normal"); cwd.set("/project"); }}><Text>Load normal</Text></View>
    <View role="button" accessibilityLabel="Hold diff refresh" onPress={() => holdRefresh.set(true)}><Text>Hold diff refresh</Text></View>
    <View role="button" accessibilityLabel="Fail diff refresh" onPress={() => failRefresh.set(true)}><Text>Fail diff refresh</Text></View>
    <View role="button" accessibilityLabel="Release diff refresh" onPress={() => { releaseRefresh?.(); releaseRefresh = null; }}><Text>Release diff refresh</Text></View>
    <View accessibilityLabel="No folder" onPress={() => { threadId.set("thread-empty"); cwd.set(null); }}><Text>No folder</Text></View>
    <View accessibilityLabel="Diff colors: blue-orange" onPress={() => updateSetting("diffColorScheme", "blue-orange")}><Text>Blue &amp; orange</Text></View>
  </View>
  {open() ? <DiffPanel threadId={threadId()} cwd={cwd()} request={rpc} onClose={() => open.set(false)} /> : null}
</View>);
