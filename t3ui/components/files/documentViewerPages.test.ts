import { expect, test } from "nsh/test";
import { base64Chunks, LOADER_PAGE, overrideDocumentViewer, partFromAsset, postViewerParts } from "./documentViewerPages";

test("the parts go to the page in order, and the loader writes the joined page once they are all in", async () => {
  expect(partFromAsset("<svg><metadata>QUJD</metadata></svg>")).toBe("QUJD");
  expect(() => partFromAsset("<svg/>")).toThrow("invalid");
  overrideDocumentViewer("pdf", ["QU", "JD"]);
  const posted: string[] = [];
  await postViewerParts("pdf", (part) => posted.push(part));
  expect(posted).toEqual(["QU", "JD"]);
  overrideDocumentViewer("pdf", null);
  expect(LOADER_PAGE.includes('"parts-done"') && LOADER_PAGE.includes("document.write(html)")).toBe(true);
});

test("the file goes to the page as base64 pieces that join back to its bytes", () => {
  const bytes = new Uint8Array(2500).map((_, index) => index % 256);
  const chunks = base64Chunks(bytes, 1000);
  expect(chunks.length).toBe(3);
  const back = chunks.flatMap((chunk) => Array.from(atob(chunk), (char) => char.charCodeAt(0)));
  expect(back).toEqual(Array.from(bytes));
});
