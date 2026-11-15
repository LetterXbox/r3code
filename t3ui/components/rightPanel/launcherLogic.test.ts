import { expect, test } from "nsh/test";
import { launcherRows, rowForKey, stepHighlight, SURFACE_DISABLED_REASONS, type LauncherState } from "./launcherLogic";

const all: LauncherState = { browser: true, terminal: true, files: true, diff: true, pullRequest: true, pullRequests: true, device: true, sideChatOffered: true, sideChatReason: null };

test("the rows follow the reference's order, with Side chat last", () => {
  expect(launcherRows(all).map((row) => row.label)).toEqual(["Browser", "Terminal", "Files", "Diff", "Pull request", "Linked pull requests", "Device", "Side chat"]);
  expect(launcherRows(all).map((row) => row.shortcut).join("")).toBe("BTFDPLMS");
});

test("Side chat exists only when the environment offers it", () => {
  expect(launcherRows({ ...all, sideChatOffered: false }).map((row) => row.label)).not.toContain("Side chat");
});

test("Side chat is disabled with the reason it cannot start", () => {
  const row = launcherRows({ ...all, sideChatReason: "Side chats start after the first message." }).find((item) => item.id === "side-chat")!;
  expect(row.available).toBe(false);
  expect(row.hint).toBe("Side chats start after the first message.");
});

test("Device and Side chat carry the reference's descriptions", () => {
  const rows = launcherRows(all);
  expect(rows.find((row) => row.id === "device")!.description).toBe("Watch an iOS Simulator or Android Emulator.");
  expect(rows.find((row) => row.id === "side-chat")!.description).toBe("Ask a side question while this thread keeps working.");
});

test("the launcher and the menu use their own tooltip copy", () => {
  const closed = { ...all, browser: false, device: false };
  expect(launcherRows(closed, "launcher").find((row) => row.id === "device")!.hint).toBe("Available from a thread.");
  expect(launcherRows(closed, "menu").find((row) => row.id === "device")!.hint).toBe(SURFACE_DISABLED_REASONS.device);
  expect(launcherRows(closed, "menu").find((row) => row.id === "browser")!.hint).toBe("Browser previews are only available in the R3 Code desktop app.");
});

test("a letter opens its row; unavailable rows, other keys and modifiers do not", () => {
  const rows = launcherRows({ ...all, diff: false });
  expect(rowForKey(rows, "b")?.id).toBe("browser");
  expect(rowForKey(rows, "M")?.id).toBe("device");
  expect(rowForKey(rows, "d")).toBeNull();
  expect(rowForKey(rows, "x")).toBeNull();
  expect(rowForKey(rows, "b", { meta: true })).toBeNull();
});

test("the arrows step through the available rows and wrap", () => {
  expect(stepHighlight(3, -1, "down")).toBe(0);
  expect(stepHighlight(3, 2, "down")).toBe(0);
  expect(stepHighlight(3, -1, "up")).toBe(2);
  expect(stepHighlight(3, 0, "left")).toBe(2);
  expect(stepHighlight(3, 1, "right")).toBe(2);
  expect(stepHighlight(0, -1, "down")).toBe(-1);
});
