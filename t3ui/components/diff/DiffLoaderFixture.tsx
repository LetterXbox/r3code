// Fixture for DiffLoader.test.tsx: a diff with far more files than anyone could see at once, so a test
// can prove the panel requests only a small, bounded slice of them and stops entirely once it is gone.
import { mount, signal, Text, View } from "nsh";
import { DiffPanel } from "./DiffPanel";

const FILE_COUNT = 500;
const files = Array.from({ length: FILE_COUNT }, (_, index) => ({
  path: `src/file${index}.ts`,
  previousPath: null as string | null,
  additions: 1,
  deletions: 0,
}));

const open = signal(true);
const fileRequestCount = signal(0);
const maxInFlight = signal(0);
let inFlight = 0;

function source(diff: string) {
  return { sources: [{ kind: "branch-range", title: "Changes", baseRef: "main", headRef: "feature", diff, files, truncated: false }] };
}

async function rpc(_method: string, payload: unknown): Promise<unknown> {
  if (typeof payload !== "object" || payload === null) throw new Error("Invalid test request");
  if (!("file" in payload)) return source("");
  const file = payload.file;
  if (typeof file !== "object" || file === null || !("path" in file) || typeof file.path !== "string") throw new Error("Invalid test file");
  fileRequestCount.update((count) => count + 1);
  inFlight++;
  maxInFlight.update((count) => Math.max(count, inFlight));
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return source(`diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1 +1 @@\n-old\n+new\n`);
  } finally {
    inFlight--;
  }
}

mount(() => <View class="flex-1 flex-row">
  <View class="w-40 gap-3">
    <View accessibilityLabel="Unmount diff panel" onPress={() => open.set(false)}><Text>Unmount diff panel</Text></View>
    <Text accessibilityLabel="file request count">{`requests:${fileRequestCount()}`}</Text>
    <Text accessibilityLabel="max in flight">{`maxInFlight:${maxInFlight()}`}</Text>
  </View>
  {open() ? <DiffPanel threadId="thread-1" cwd="/project" request={rpc} /> : null}
</View>);
