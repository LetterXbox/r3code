import { expect, test } from "nsh/test";
import { fileUriToPath, isLocalServer, promptWithFolders, splitDroppedUris } from "./folderDrop";
import { collectPromptTokens } from "./editor/promptDocument";

test("file URLs become local paths and anything else is refused", () => {
  expect(fileUriToPath("file:///Users/me/My%20Dir/a.png")).toBe("/Users/me/My Dir/a.png");
  expect(fileUriToPath("/tmp/x")).toBe("/tmp/x");
  expect(fileUriToPath("https://example.com/a")).toBeNull();
  expect(fileUriToPath("file://other-host/Users/me/project")).toBeNull();
});

test("dropped folders split from files by what is on disk", async () => {
  const dirs = new Set(["/work/pkg"]);
  const result = await splitDroppedUris(["file:///work/pkg/", "file:///work/a.png", "https://x/y"], async (path) => dirs.has(path.replace(/\/+$/, "")));
  expect(result).toEqual({ folders: ["/work/pkg"], files: ["file:///work/a.png", "https://x/y"] });
});

test("only a server on this computer can take folder mentions", () => {
  expect(isLocalServer("http://127.0.0.1:52689")).toBe(true);
  expect(isLocalServer("ws://localhost:3773/ws")).toBe(true);
  expect(isLocalServer("https://box.example.com")).toBe(false);
  expect(isLocalServer("not a url")).toBe(false);
});

test("each folder is appended as a mention the editor chips as a folder", () => {
  const { text, sources } = promptWithFolders("look in", ["/work/pkg", "/work/other dir"]);
  expect(text).toBe("look in [pkg](/work/pkg) [other dir](/work/other%20dir) ");
  expect(sources.length).toBe(2);
  const tokens = collectPromptTokens(text, { skills: new Map(), folders: new Set(sources) });
  expect(tokens.map((token) => [token.kind, token.value])).toEqual([["folder", "/work/pkg"], ["folder", "/work/other dir"]]);
  expect(promptWithFolders(text, ["/work/pkg"]).text).toBe(text);
});
