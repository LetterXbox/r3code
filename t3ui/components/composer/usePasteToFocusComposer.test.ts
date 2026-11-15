import { expect, test } from "nsh/test";
import { pasteIntoComposer } from "./usePasteToFocusComposer";

test("an image paste with no focused editor attaches the image", async () => {
  const received: string[] = [];
  const file = new File(["image bytes"], "image.png", { type: "image/png" });
  const pasted = await pasteIntoComposer({
    insertText: (text) => received.push(`text:${text}`),
    attachPaths: (paths) => received.push(...paths),
    attachFiles: (files) => received.push(...files.map((entry) => entry.name)),
  }, { files: async () => [], image: async () => file, text: async () => "fallback text" });
  expect(pasted).toBe(true);
  expect(received).toEqual(["image.png"]);
});

test("file paths take precedence over image data and text", async () => {
  const received: string[] = [];
  await pasteIntoComposer({
    insertText: (text) => received.push(text),
    attachPaths: (paths) => received.push(...paths),
    attachFiles: (files) => received.push(...files.map((entry) => entry.name)),
  }, { files: async () => ["file:///tmp/photo.png"], image: async () => new File([], "image.png"), text: async () => "text" });
  expect(received).toEqual(["file:///tmp/photo.png"]);
});

test("a clipboard read finishing after a conversation switch does not paste into the new conversation", async () => {
  let current = true;
  let finish: (value: string[]) => void = () => {};
  const files = new Promise<string[]>((resolve) => { finish = resolve; });
  const received: string[] = [];
  const paste = pasteIntoComposer({ isCurrent: () => current, insertText: (text) => received.push(text), attachPaths: (paths) => received.push(...paths), attachFiles: (items) => received.push(...items.map((item) => item.name)) }, { files: () => files, text: async () => "text" });
  current = false;
  finish(["file:///tmp/image.png"]);
  expect(await paste).toBe(false);
  expect(received).toEqual([]);
});
