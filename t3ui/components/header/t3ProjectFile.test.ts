import { expect, test } from "nsh/test";
import { importableScripts, importInput, parseLenientJson, parseT3ProjectScripts, readT3ProjectScripts } from "./t3ProjectFile";

test("the file may carry comments and trailing commas, but a URL in a string keeps its slashes", () => {
  const parsed = parseLenientJson(`{
    // the team's scripts
    "scripts": [
      { "name": "Dev", "command": "bun dev", "previewUrl": "http://localhost:3000", /* open it */ },
    ],
  }`) as { scripts: { previewUrl: string }[] };
  expect(parsed.scripts[0]!.previewUrl).toBe("http://localhost:3000");
});

test("scripts are read with their options and trimmed", () => {
  expect(parseT3ProjectScripts('{"scripts":[{"name":" Lint ","command":" bun lint ","icon":"lint","runOnWorktreeCreate":true,"async":false,"previewUrl":"http://x","autoOpenPreview":true}]}')).toEqual([
    { name: "Lint", command: "bun lint", icon: "lint", runOnWorktreeCreate: true, async: false, previewUrl: "http://x", autoOpenPreview: true },
  ]);
  expect(parseT3ProjectScripts("{}")).toEqual([]);
});

test("a file that does not match the schema offers nothing: bad JSON, an empty name, an unknown icon, a wrong type, too many scripts", () => {
  expect(parseT3ProjectScripts("{ nope")).toBeNull();
  expect(parseT3ProjectScripts('{"scripts":[{"name":"  ","command":"x"}]}')).toBeNull();
  expect(parseT3ProjectScripts('{"scripts":[{"name":"a","command":"x","icon":"rocket"}]}')).toBeNull();
  expect(parseT3ProjectScripts('{"scripts":[{"name":"a","command":"x","async":"no"}]}')).toBeNull();
  expect(parseT3ProjectScripts(`{"scripts":[${Array.from({ length: 51 }, (_, i) => `{"name":"s${i}","command":"c${i}"}`).join(",")}]}`)).toBeNull();
  expect(parseT3ProjectScripts('{"scripts":"x"}')).toBeNull();
});

test("a script the project has by command or by name (any case) is not offered again", () => {
  const file = [{ name: "Another", command: "bun test" }, { name: "test", command: "bun run unit" }, { name: "Lint", command: "bun lint" }];
  expect(importableScripts(file, [{ name: "Test", command: "bun test" }]).map((script) => script.name)).toEqual(["Lint"]);
  expect(importableScripts(file, [])).toHaveLength(3);
});

test("an import carries the file's options and leaves the shortcut alone", () => {
  expect(importInput({ name: "Lint", command: "bun lint", icon: "lint", runOnWorktreeCreate: true, async: false, previewUrl: "http://x", autoOpenPreview: true })).toEqual({
    name: "Lint", command: "bun lint", icon: "lint", runOnWorktreeCreate: true, waitForSetup: true, runOnSettle: false, stopOnSettle: false, keybinding: "", previewUrl: "http://x", autoOpenPreview: true,
  });
  expect(importInput({ name: "Dev", command: "bun dev", autoOpenPreview: true }).autoOpenPreview).toBe(false);
  expect(importInput({ name: "Dev", command: "bun dev", runOnWorktreeCreate: true }).waitForSetup).toBe(false);
});

test("t3.json is read from the project root, and an absent or truncated file gives none", async () => {
  const calls: unknown[] = [];
  const found = await readT3ProjectScripts("/repo", async (method, payload) => { calls.push([method, payload]); return { relativePath: "t3.json", contents: '{"scripts":[{"name":"Dev","command":"bun dev"}]}', byteLength: 10, truncated: false }; });
  expect(calls).toEqual([["projects.readFile", { cwd: "/repo", relativePath: "t3.json", allowMissing: true }]]);
  expect(found).toHaveLength(1);
  expect(await readT3ProjectScripts("/repo", async () => ({ relativePath: "t3.json", contents: "", byteLength: 0, truncated: false, exists: false }))).toEqual([]);
  expect(await readT3ProjectScripts("/repo", async () => ({ relativePath: "t3.json", contents: "{}", byteLength: 2, truncated: true }))).toEqual([]);
});
