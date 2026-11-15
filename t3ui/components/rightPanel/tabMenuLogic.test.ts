import { expect, test } from "nsh/test";
import { clipboardPathFor, formatFilePathForClipboard, tabMenuItems } from "./tabMenuLogic";
import { audioScript, isTabMuted, parseAudioMessage, registerTabAudio, reportTabAudible, setTabMuted, tabAudioState } from "./previewAudio";

const labels = (kind: "device" | "file" | "preview" | "diff", context = { count: 3, index: 1 } as Parameters<typeof tabMenuItems>[1]) => tabMenuItems({ kind }, context).map((item) => item.label);

test("a device tab offers Rename, a file tab Copy path, a browser tab Mute tab", () => {
  expect(labels("device")).toEqual(["Rename", "Close", "Close others", "Close to the right", "Close all"]);
  expect(labels("file")).toEqual(["Copy path", "Close", "Close others", "Close to the right", "Close all"]);
  expect(labels("preview", { count: 3, index: 1, mute: { ready: true, muted: false } })).toEqual(["Mute tab", "Close", "Close others", "Close to the right", "Close all"]);
  expect(labels("preview", { count: 3, index: 1, mute: { ready: true, muted: true } })[0]).toBe("Unmute tab");
  expect(labels("diff")).toEqual(["Close", "Close others", "Close to the right", "Close all"]);
});

test("Close others and Close to the right are disabled where there is nothing to close; Mute waits for the page", () => {
  const items = tabMenuItems({ kind: "preview" }, { count: 1, index: 0, mute: { ready: false, muted: false } });
  expect(items.find((item) => item.id === "close-others")!.disabled).toBe(true);
  expect(items.find((item) => item.id === "close-to-right")!.disabled).toBe(true);
  expect(items.find((item) => item.id === "toggle-mute")!.disabled).toBe(true);
  expect(items.find((item) => item.id === "close")!.disabled).toBeUndefined();
  expect(tabMenuItems({ kind: "files" }, { count: 2, index: 0 }).find((item) => item.id === "close-to-right")!.disabled).toBe(false);
});

test("Copy path copies the relative path in the host's separators", () => {
  expect(clipboardPathFor("src/main.ts", "/work/app")).toBe("src/main.ts");
  expect(clipboardPathFor("src/main.ts", "C:\\work\\app")).toBe("src\\main.ts");
  expect(formatFilePathForClipboard("a/b", "/unix/a/b")).toBe("a/b");
  expect(formatFilePathForClipboard("a/b", "D:/win/a/b")).toBe("a\\b");
});

test("a tab's sound shows once the page plays, crossed out while muted, and muting reaches the page", () => {
  const sent: boolean[] = [];
  const release = registerTabAudio("browser:9", (muted) => sent.push(muted));
  expect(tabAudioState("browser:9")).toBe("none");
  reportTabAudible("browser:9", true);
  expect(tabAudioState("browser:9")).toBe("audible");
  setTabMuted("browser:9", true);
  expect(tabAudioState("browser:9")).toBe("muted");
  expect(isTabMuted("browser:9")).toBe(true);
  expect(sent[sent.length - 1]).toBe(true);
  setTabMuted("browser:9", false);
  expect(tabAudioState("browser:9")).toBe("audible");
  release();
  expect(tabAudioState("browser:9")).toBe("none");
});

test("the page's report is read, and nothing else a page posts is taken for one", () => {
  expect(parseAudioMessage('{"t3":"audio","audible":true}')).toBe(true);
  expect(parseAudioMessage('{"t3":"audio","audible":false}')).toBe(false);
  expect(parseAudioMessage('{"audible":true}')).toBeNull();
  expect(parseAudioMessage("not json")).toBeNull();
  expect(audioScript(true)).toContain("var muted = true");
  expect(audioScript(false)).toContain("var muted = false");
});
