import { expect, test } from "nsh/test";
import { freeDownloadPath, openMediaLink, readDataUrl, readMediaUrl } from "./mediaContent";
import { mediaMenuItems } from "./MarkdownMedia";

test("media reads use the reference's error copy", async () => {
  expect(readDataUrl("data:image/png;base64,AAEC").bytes).toEqual(new Uint8Array([0, 1, 2]));
  let message = "";
  try { readDataUrl("data:image/png;base64"); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("This inline media could not be decoded.");
  const page = async () => ({ ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" }, arrayBuffer: async () => new ArrayBuffer(0) });
  try { await readMediaUrl("https://x/a.png", page as any); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("This link returned a web page instead of media. Open the original URL.");
  const missing = async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
  try { await readMediaUrl("https://x/a.png", missing as any); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("The file could not be fetched (HTTP 404).");
  const offline = async () => { throw new Error("x"); };
  try { await readMediaUrl("https://x/a.png", offline as any); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("The file could not be fetched. Check the connection and try again.");
});

test("downloads get a free name; menu offers Save and Copy image", async () => {
  const taken = new Set(["/d/a.png", "/d/a (1).png"]);
  expect(await freeDownloadPath("/d", "a.png", async (path) => taken.has(path))).toBe("/d/a (2).png");
  const labels = mediaMenuItems({ kind: "url", url: "https://x/a.png" }, null, { kind: "image", name: "a" }).map((item) => item.label);
  expect(labels).toEqual(["Copy URL", "Save image", "Copy image"]);
  expect(mediaMenuItems({ kind: "url", url: "https://x/a.mp4" }, null, { kind: "video", name: "a" }).map((item) => item.label)).toEqual(["Copy URL", "Save video"]);
  expect(openMediaLink({ src: "https://x/v.mp4" })).toEqual({ label: "Open in browser", url: "https://x/v.mp4" });
  expect(openMediaLink({ originalUrl: "https://x/p", src: "https://x/v.mp4" })?.label).toBe("Open original");
  expect(openMediaLink({ src: "file:///v.mp4" })).toBe(null);
});
