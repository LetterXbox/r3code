import { expect, test } from "nsh/test";
import { linkMetadataPath, resolvePathLinkTarget, splitFilePathPosition, terminalLinkTarget, validatePathLink } from "./terminalLinks";

test("a path link splits into its path, line and column", () => {
  expect(splitFilePathPosition("src/a.ts:12:3")).toEqual({ path: "src/a.ts", line: 12, column: 3 });
  expect(splitFilePathPosition("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
  expect(splitFilePathPosition("src/a.ts")).toEqual({ path: "src/a.ts" });
  expect(splitFilePathPosition("src/a.ts:0")).toEqual({ path: "src/a.ts" });
});

test("a relative or home path is anchored to the terminal's directory, keeping its position", () => {
  expect(resolvePathLinkTarget("src/a.ts:12:3", "/repo")).toBe("/repo/src/a.ts:12:3");
  expect(resolvePathLinkTarget("./a.ts", "/repo/")).toBe("/repo/./a.ts");
  expect(resolvePathLinkTarget("/etc/hosts", "/repo")).toBe("/etc/hosts");
  expect(resolvePathLinkTarget("~/notes.md:4", "/Users/kim/work")).toBe("/Users/kim/notes.md:4");
  expect(resolvePathLinkTarget("src\\a.ts", "C:\\work")).toBe("C:\\work\\src\\a.ts");
});

test("the server is asked about the absolute path without its position, and never about a network or overlong path", () => {
  expect(linkMetadataPath("src/a.ts:12:3", "/repo")).toBe("/repo/src/a.ts");
  expect(linkMetadataPath("~/a.ts", "/repo")).toBe("~/a.ts");
  expect(linkMetadataPath("/repo/dir/", "/x")).toBe("/repo/dir");
  expect(linkMetadataPath("//host/share/a.ts", "/repo")).toBeNull();
  expect(linkMetadataPath(`/${"a".repeat(600)}`, "/repo")).toBeNull();
});

test("a path is a link only when the server finds a file or directory there", async () => {
  const asked: unknown[] = [];
  const reply = (entry: unknown) => async (method: string, payload: unknown) => { asked.push([method, payload]); return { entries: [entry] }; };
  expect(await validatePathLink("src/a.ts:1", "/repo", reply({ kind: "file" }))).toBe(true);
  expect(await validatePathLink("src", "/repo", reply({ kind: "directory" }))).toBe(true);
  expect(await validatePathLink("src", "/repo", reply({ kind: "other" }))).toBe(false);
  expect(await validatePathLink("src", "/repo", reply(null))).toBe(false);
  expect(await validatePathLink("src", "/repo", async () => { throw new Error("denied"); })).toBe(false);
  expect(await validatePathLink("//host/x", "/repo", reply({ kind: "file" }))).toBe(false);
  expect(asked[0]).toEqual(["filesystem.getMetadata", { paths: ["/repo/src/a.ts"] }]);
  // The network path never reaches the server, and the failing server was asked but answered nothing.
  expect(asked.length).toBe(4);
});

test("a web link opens in the app only when the setting says so, the panel exists and Cmd/Ctrl is not held", () => {
  expect(terminalLinkTarget("app", false, true)).toBe("app");
  expect(terminalLinkTarget("app", true, true)).toBe("system");
  expect(terminalLinkTarget("app", false, false)).toBe("system");
  expect(terminalLinkTarget("system", false, true)).toBe("system");
  expect(terminalLinkTarget(undefined, false, true)).toBe("system");
});
