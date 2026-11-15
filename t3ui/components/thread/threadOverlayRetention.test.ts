import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { startThreadOverlayRetention } from "./threadOverlayRetention";
import { closeExpandedMedia, expandedMediaPreview, expandMedia } from "./markdown/ExpandedMedia";

test("a media preview opened for one thread is dropped when another thread opens, kept while it stays", async () => {
  const open = signal<string | null>("t1");
  startThreadOverlayRetention(() => open());
  expandMedia({ items: [{ kind: "image", src: { kind: "url", url: "https://x/a.png" }, name: "a.png" } as never], index: 0 });
  expect(expandedMediaPreview()).not.toBe(null);
  open.set("t1");
  await new Promise((res) => setTimeout(res, 5));
  expect(expandedMediaPreview()).not.toBe(null);
  open.set("t2");
  await new Promise((res) => setTimeout(res, 5));
  expect(expandedMediaPreview()).toBe(null);
  expandMedia({ items: [{ kind: "image", src: { kind: "url", url: "https://x/b.png" }, name: "b.png" } as never], index: 0 });
  open.set(null);
  await new Promise((res) => setTimeout(res, 5));
  expect(expandedMediaPreview()).toBe(null);
  closeExpandedMedia();
});
