import { mount, signal, Text, View } from "nsh";
import { FilesPanel } from "./FilesPanel";
import { FilePreview } from "./FilePreview";

const opened = signal("none");
const failing = signal(true);
const calls = signal<string[]>([]);
let holdRoot = false;
let failRoot = false;
let releaseRoot: (() => void) | null = null;
const tree: Record<string, unknown> = {
  "": { entries: [{ path: "src", kind: "directory" }, { path: "readme.md", kind: "file" }, { path: "notes.md", kind: "file" }, { path: "logo.png", kind: "file" }, { path: "blob.bin", kind: "file" }, { path: "data.csv", kind: "file" }, { path: "nb.ipynb", kind: "file" }, { path: "report.docx", kind: "file" }, { path: "doc.pdf", kind: "file" }, { path: "node_modules", kind: "directory", ignored: true }], truncated: false },
  src: { entries: [{ path: "src/main.ts", kind: "file" }, { path: "src/lib", kind: "directory" }], truncated: false },
  "src/lib": { entries: [{ path: "src/lib/util.ts", kind: "file" }], truncated: false },
};

async function rpc(method: string, payload: unknown): Promise<unknown> {
  const body = payload as Record<string, string | undefined>;
  calls.update((all) => [...all, `${method}:${body.directoryPath ?? body.relativePath ?? ""}`]);
  if (method === "projects.listEntries") {
    const dir = body.directoryPath ?? "";
    if (dir === "" && holdRoot) { holdRoot = false; await new Promise<void>((resolve) => { releaseRoot = resolve; }); }
    if (dir === "" && failRoot) { failRoot = false; throw new Error("Refresh unavailable"); }
    if (dir === "src/lib" && failing()) { failing.set(false); throw new Error("Folder unavailable"); }
    return tree[dir] ?? { entries: [], truncated: false };
  }
  if (method === "projects.searchEntries") {
    const q = String((payload as { query?: string }).query ?? "");
    return { entries: q === "util" ? [{ path: "src/lib/util.ts", kind: "file" }] : [], truncated: q === "util" };
  }
  if (body.relativePath === "image.png" || body.relativePath === "blob.bin") throw new Error("File is binary_file");
  if (body.relativePath === "data.csv") return { relativePath: "data.csv", contents: 'name,note\r\nada,"hello, world"\r\nlin,"say ""hi"""\r\n', byteLength: 52, truncated: false };
  if (body.relativePath === "nb.ipynb") return { relativePath: "nb.ipynb", contents: JSON.stringify({ nbformat: 4, metadata: { kernelspec: { language: "python" } }, cells: [{ cell_type: "markdown", source: ["Notebook intro"] }, { cell_type: "code", execution_count: 1, source: ["print(42)"], outputs: [{ output_type: "stream", name: "stdout", text: ["42\\n"] }] }] }), byteLength: 300, truncated: false };
  if (body.relativePath === "big.txt") return { relativePath: "big.txt", contents: "line\n", byteLength: 9000000, truncated: true };
  return { relativePath: body.relativePath, contents: "const a = 1;\nconst b = 2;\n", byteLength: 26, truncated: false };
}

// A 1x1 PNG for logo.png; anything else read as bytes is not on this disk.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function readBytes(_cwd: string, relativePath: string): Promise<Uint8Array> {
  if (relativePath === "logo.png") return PNG;
  throw new Error("The file could not be loaded. Close it and try again.");
}

mount(() => (
  <View class="flex-1 flex-row">
    <View class="w-[300px]"><View role="button" accessibilityLabel="Hold file refresh" onPress={() => { holdRoot = true; }}><Text>Hold file refresh</Text></View><View role="button" accessibilityLabel="Fail file refresh" onPress={() => { failRoot = true; }}><Text>Fail file refresh</Text></View><View role="button" accessibilityLabel="Release file refresh" onPress={() => { releaseRoot?.(); releaseRoot = null; }}><Text>Release file refresh</Text></View><FilesPanel cwd="/project" projectName="demo" onOpenFile={(path) => opened.set(path)} request={rpc} /></View>
    <View class="flex-1">
      <Text>{`opened: ${opened()}`}</Text>
      <Text>{calls().join(",")}</Text>
      {opened() !== "none" ? <FilePreview cwd="/project" relativePath={opened()} projectName="demo" line={opened() === "readme.md" ? 2 : undefined} request={rpc} readBytes={readBytes} /> : null}
    </View>
  </View>
));
