// loadFileAncestors: a tree opened with a deep file selected reads and opens that file's folders.
import { mount, View } from "nsh";
import { FilesPanel } from "./FilesPanel";

const tree: Record<string, unknown> = {
  "": { entries: [{ path: "src", kind: "directory" }, { path: "readme.md", kind: "file" }], truncated: false },
  src: { entries: [{ path: "src/main.ts", kind: "file" }, { path: "src/lib", kind: "directory" }], truncated: false },
  "src/lib": { entries: [{ path: "src/lib/util.ts", kind: "file" }], truncated: false },
};

async function rpc(method: string, payload: unknown): Promise<unknown> {
  if (method !== "projects.listEntries") throw new Error(`Unexpected ${method}`);
  return tree[(payload as { directoryPath?: string }).directoryPath ?? ""] ?? { entries: [], truncated: false };
}

mount(() => <View class="w-[300px] flex-1"><FilesPanel cwd="/project" projectName="demo" selectedPath={() => "src/lib/util.ts"} onOpenFile={() => {}} request={rpc} /></View>);
