import { expect, test } from "nsh/test";
import { overridePanelContext, panelStateFor } from "../../rightPanel/panelState";
import { filePanelPath, openFilePath } from "./MarkdownChips";
import { resolveInlineCodeFileLinkMeta, resolveMarkdownFileLinkMeta } from "./fileLinkMeta";

const CWD = "/work/legion";
let KEY = "";
let counter = 0;
const surfaces = () => panelStateFor(KEY).surfaces.map((surface) => `${surface.id}${surface.line ? `@${surface.line}` : ""}`);

function setup(cwd: string | null = CWD) {
  KEY = JSON.stringify(["test", `thread-${++counter}`]);
  overridePanelContext({ key: KEY, workspace: { threadId: "thread-1", cwd } });
}

test("a chip for an absolute path inside the workspace opens a file tab at its relative path and line", async () => {
  setup();
  const meta = resolveMarkdownFileLinkMeta("/work/legion/t3ui/pages/ThreadView.tsx:42", CWD)!;
  expect(meta.workspaceRelativePath).toBe("t3ui/pages/ThreadView.tsx");
  await openFilePath(meta);
  expect(surfaces()).toEqual(["file:t3ui/pages/ThreadView.tsx@42"]);
  expect(panelStateFor(KEY).open).toBe(true);
  expect(panelStateFor(KEY).activeId).toBe("file:t3ui/pages/ThreadView.tsx");
  overridePanelContext(null);
});

test("an inline-code path chip opens the same way", async () => {
  setup();
  const meta = resolveInlineCodeFileLinkMeta("t3ui/pages/ThreadView.tsx", CWD)!;
  await openFilePath(meta);
  expect(surfaces()).toContain("file:t3ui/pages/ThreadView.tsx");
  overridePanelContext(null);
});

test("a host path outside the workspace opens in the panel, and a folder chip does too", async () => {
  setup();
  expect(filePanelPath({ filePath: "/etc/hosts", workspaceRelativePath: null })).toBe("/etc/hosts");
  expect(filePanelPath({ filePath: "/etc/clip.mp4", workspaceRelativePath: null })).toBe(null);
  await openFilePath(resolveMarkdownFileLinkTargetMeta("/etc/hosts.conf"));
  await openFilePath(resolveMarkdownFileLinkTargetMeta("/Users/jkneen/.t3"));
  expect(surfaces()).toEqual(["file:/etc/hosts.conf", "file:/Users/jkneen/.t3"]);
  overridePanelContext(null);
});

test("a bare file name is looked up in the workspace before it opens", async () => {
  setup();
  const meta = resolveMarkdownFileLinkMeta("ThreadView.tsx", CWD)!;
  expect(meta.workspaceLookupPath).toBe("ThreadView.tsx");
  const asked: string[] = [];
  await openFilePath(meta, { search: async (cwd, query) => { asked.push(`${cwd}:${query}`); return [{ path: "t3ui/pages/ThreadView.tsx", kind: "file" }, { path: "docs", kind: "directory" }]; } });
  expect(asked).toEqual(["/work/legion:ThreadView.tsx"]);
  expect(surfaces()).toEqual(["file:t3ui/pages/ThreadView.tsx"]);
  overridePanelContext(null);
});

test("a path that repeats the project's folders opens at the stripped match", async () => {
  setup();
  const meta = resolveMarkdownFileLinkMeta("legion/src/a.ts", CWD)!;
  await openFilePath(meta, { search: async () => [{ path: "src/a.ts", kind: "file" }] });
  expect(surfaces()).toEqual(["file:src/a.ts"]);
  overridePanelContext(null);
});

test("the modified press and a thread with no panel do not open a tab", async () => {
  setup();
  const meta = resolveMarkdownFileLinkMeta("/work/legion/a.ts", CWD)!;
  await openFilePath(meta, { modified: true });
  expect(surfaces()).toEqual([]);
  overridePanelContext({ key: null, workspace: null });
  await openFilePath(meta).catch(() => {});
  expect(panelStateFor(KEY).surfaces.length).toBe(0);
  overridePanelContext(null);
});

function resolveMarkdownFileLinkTargetMeta(path: string) {
  return resolveMarkdownFileLinkMeta(path, CWD)!;
}
