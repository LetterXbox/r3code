import { expect, test } from "nsh/test";
import { configureDesktop } from "./runtime";
import { pickFolder } from "./dialogs";

const calls: string[][] = [];
let reply = { code: 0, stdout: "/Users/me/project/\n", stderr: "" };
configureDesktop({ os: () => "macos", run: async (command, args) => { calls.push([command, ...args]); return reply; } });

test("pickFolder runs choose folder through osascript and trims the path", async () => {
  expect(await pickFolder({ initialPath: "/Users/me" })).toBe("/Users/me/project");
  expect(calls[0]).toEqual(["/usr/bin/osascript", "-e", 'POSIX path of (choose folder default location (POSIX file "/Users/me"))']);
});

test("cancel (-128) is null", async () => {
  reply = { code: 1, stdout: "", stderr: "execution error: User canceled. (-128)" };
  expect(await pickFolder()).toBe(null);
  expect(calls[1]).toEqual(["/usr/bin/osascript", "-e", "POSIX path of (choose folder)"]);
});
