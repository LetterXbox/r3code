import { mount, signal, Text, View } from "nsh";
import { FilePreview } from "./FilePreview";
import { base64Bytes, SQLITE_BASE64, TGZ_BASE64, ZIP_BASE64 } from "./binaryFixtures";
import { setFilesystemAccessForTest } from "./fileSaveRuntime";
import { DOCX_BASE64, XLSX_BASE64 } from "./officeFixtures";

const opened = signal("a.ts");
const writes = signal<string[]>([]);
const writable = signal(true);
setFilesystemAccessForTest("writable");

const files: Record<string, string> = { "a.ts": "const a = 1;\n", "flow.mmd": "graph TD\n  A --> B\n", "big.txt": "first\n" };
async function rpc(method: string, payload: unknown): Promise<unknown> {
  const body = payload as { relativePath: string; contents?: string };
  if (method === "projects.listEntries") return { entries: [{ path: "a.ts", kind: "file" }], truncated: false };
  if (method === "projects.writeFile") { writes.update((all) => [...all, `${body.relativePath}=${body.contents}`]); return {}; }
  if (body.relativePath === "/Users/x/.t3") throw new Error("path_not_file");
  if (body.relativePath === "big.txt") return { relativePath: "big.txt", contents: "first\n", byteLength: 2_000_000, truncated: true };
  if (body.relativePath in files) return { relativePath: body.relativePath, contents: files[body.relativePath], byteLength: files[body.relativePath]!.length, truncated: false };
  throw new Error("File is binary_file");
}
const bytes: Record<string, Uint8Array> = {
  "big.txt": new TextEncoder().encode("first\nsecond\nthird\n"),
  "x.zip": base64Bytes(ZIP_BASE64), "x.tgz": base64Bytes(TGZ_BASE64), "x.db": base64Bytes(SQLITE_BASE64),
  "x.docx": base64Bytes(DOCX_BASE64), "x.xlsx": base64Bytes(XLSX_BASE64),
};
const readBytes = async (_cwd: string, path: string) => { const found = bytes[path]; if (!found) throw new Error("The file could not be loaded. Close it and try again."); return found; };

mount(() => (
  <View class="flex-1">
    <Text>{`writes: ${writes().join("|")}`}</Text>
    <View class="flex-row">
      {["a.ts", "/Users/x/.t3", "flow.mmd", "big.txt", "x.zip", "x.db", "x.docx", "x.xlsx"].map((path) => <View role="button" accessibilityLabel={`open ${path}`} onPress={() => opened.set(path)}><Text>{path}</Text></View>)}
      <View role="button" accessibilityLabel="toggle write" onPress={() => { writable.update((value) => !value); setFilesystemAccessForTest(writable() ? "writable" : "readonly"); }}><Text>{`write:${writable()}`}</Text></View>
    </View>
    <FilePreview cwd="/project" relativePath={opened()} projectName="demo" request={rpc} readBytes={readBytes} fullFileAvailable={() => true} explorer />
  </View>
));
