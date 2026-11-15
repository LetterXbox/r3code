import { expect, test } from "nsh/test";
import { collageRows, LONE_IMAGE_FALLBACK_WIDTH, fileCardDetail, formatBytes, formatClock, isThumbnailImage, loneImageWidth, splitAttachments } from "./mediaLayout";

const attachment = (id: string, type: string, mimeType: string, name = id) => ({ id, name, type, mimeType, sizeBytes: 2048 });

test("only displayable image types become thumbnails", () => {
  expect(isThumbnailImage(attachment("a", "image", "image/png"))).toBe(true);
  expect(isThumbnailImage(attachment("b", "image", "image/svg+xml"))).toBe(false);
  expect(isThumbnailImage(attachment("c", "file", "image/png"))).toBe(false);
  const split = splitAttachments([attachment("a", "image", "image/png"), attachment("b", "file", "text/plain")]);
  expect(split.images.length).toBe(1);
  expect(split.files.length).toBe(1);
});

test("a lone image keeps its aspect within the lane", () => {
  expect(loneImageWidth(null)).toBe(LONE_IMAGE_FALLBACK_WIDTH);
  expect(loneImageWidth({ width: 400, height: 200 })).toBe(384);
  expect(loneImageWidth({ width: 100, height: 400 })).toBe(96);
  expect(loneImageWidth({ width: 300, height: 300 })).toBe(192);
});

test("collage rows follow the reference grids", () => {
  expect(collageRows(2)).toEqual({ kind: "pair", rows: [[0, 1]], height: 192 });
  expect(collageRows(3).kind).toBe("trio");
  expect(collageRows(5)).toEqual({ kind: "grid", rows: [[0, 1], [2, 3], [4]], height: 288 });
});

test("file cards name the extension and size", () => {
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(12)).toBe("12 B");
  expect(fileCardDetail(attachment("r", "file", "application/pdf", "report.pdf"))).toBe("PDF · 2 KB");
  expect(fileCardDetail(attachment("r", "file", "text/plain", "README"))).toBe("File · 2 KB");
});

test("videos and audio split from images and files by their type, and the clock reads m:ss", () => {
  const split = splitAttachments([attachment("a", "image", "image/png"), attachment("v", "file", "video/mp4"), attachment("s", "file", "audio/mpeg; codecs=x"), attachment("t", "file", "text/plain")]);
  expect(split.images.map((item) => item.id)).toEqual(["a"]);
  expect(split.videos.map((item) => item.id)).toEqual(["v"]);
  expect(split.audio.map((item) => item.id)).toEqual(["s"]);
  expect(split.files.map((item) => item.id)).toEqual(["t"]);
  expect(formatClock(65.9)).toBe("1:05");
  expect(formatClock(Number.NaN)).toBe("0:00");
});

test("file cards: a pasted text reads Pasted text without an extension; an unsent file reads Sending…", async () => {
  const { fileCardDetail, userMessageFileLabel } = await import("./mediaLayout");
  const pasted = { id: "a", name: "pasted-text.txt", mimeType: "text/plain", sizeBytes: 2048, type: "file", source: "pasted-text" };
  expect(userMessageFileLabel(pasted)).toBe("Pasted text");
  expect(fileCardDetail(pasted)).toBe("2 KB");
  const file = { id: "b", name: "notes.md", mimeType: "text/markdown", sizeBytes: 2048, type: "file" };
  expect(userMessageFileLabel(file)).toBe("notes.md");
  expect(fileCardDetail(file)).toBe("MD · 2 KB");
  expect(fileCardDetail(file, true)).toBe("Sending…");
});

test("a file card's Download writes the file's bytes to Downloads under its name", async () => {
  const { downloadAttachment } = await import("./MessageMedia");
  const written: { path: string; size: number }[] = [];
  const file = { id: "f1", name: "a/b.txt", mimeType: "text/plain", sizeBytes: 3, type: "file" };
  const path = await downloadAttachment(file, () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])), (target, data) => { written.push({ path: target, size: data.length }); return Promise.resolve(); });
  expect(path?.endsWith("/Downloads/a_b.txt")).toBe(true);
  expect(written.map((entry) => entry.size)).toEqual([3]);
});
