// Fixture for DiffContext.test.tsx: a branch diff of one file whose two hunks leave unchanged lines between and
// around them, and review.getDiffFileContents answering with the file's two texts (ReviewDiffFileContentsResult).
import { mount, signal, Text, View } from "nsh";
import { DiffPanel } from "./DiffPanel";
import { updateSetting } from "../../store";

const oldLines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
const newLines = [...oldLines.slice(0, 5), "LINE 6", ...oldLines.slice(6)];
const patch = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
  "@@ -3,7 +3,7 @@", " line 3", " line 4", " line 5", "-line 6", "+LINE 6", " line 7", " line 8", " line 9",
  "@@ -40,3 +40,3 @@", " line 40", "-line 41", "+line 41", " line 42", "",
].join("\n");
const files = [{ path: "src/a.ts", previousPath: null, additions: 2, deletions: 2 }];
const contentRequests = signal<string[]>([]);

async function rpc(method: string, payload: unknown): Promise<unknown> {
  const input = payload as Record<string, unknown>;
  if (method === "review.getDiffFileContents") {
    contentRequests.update((all) => [...all, `${input.sourceKind} ${input.changeType} ${input.baseRef} ${input.headRef} ${input.oldPath} ${input.newPath}`]);
    return { oldContents: `${oldLines.join("\n")}\n`, newContents: `${newLines.join("\n")}\n` };
  }
  const body = "file" in input ? patch : "";
  return { sources: [{ kind: "branch-range", title: "Changes", baseRef: "main", headRef: "feature", diff: body, files, truncated: false }] };
}

updateSetting("diffIgnoreWhitespace", true);
mount(() => <View class="flex-1 flex-row">
  <View class="w-40"><Text accessibilityLabel="Content requests">{contentRequests().join("|")}</Text></View>
  <DiffPanel threadId="thread-ctx" cwd="/project" request={rpc} canReadFiles={() => true} />
</View>);
