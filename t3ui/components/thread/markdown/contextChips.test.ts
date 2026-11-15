import { expect, test } from "nsh/test";
import { buildReviewCommentRenderablePatch, chipColor, chipifyContextLinks, chipLabel, parseContextRecords, withAnnotationImages } from "./contextChips";

test("context links and image references become chips; plain links stay unchanged", () => {
  const text = "see [@a.ts](t3-context://v1/mention/m_1) and ![shot](t3-context://v1/image/i_1) and [web](https://x.dev)";
  expect(chipifyContextLinks(text)).toBe("see ⟦mention|m_1|@a.ts⟧ and ⟦image|i_1|shot⟧ and [web](https://x.dev)");
  expect(chipifyContextLinks("no context")).toBe("no context");
});

test("records are read by context id and malformed ones dropped", () => {
  const records = parseContextRecords({ version: 1, records: [
    { contextId: "m_1", kind: "mention", label: "a.ts", path: "src/a.ts" },
    { contextId: "t_1", kind: "thread", label: "Fix it", threadId: "thread-9", environmentId: "env-1" },
    { kind: "skill" }, 7, null,
  ] });
  expect(Object.keys(records)).toEqual(["m_1", "t_1"]);
  expect(records.m_1.path).toBe("src/a.ts");
  expect(records.t_1.threadId).toBe("thread-9");
  expect(parseContextRecords(undefined)).toEqual({});
});

test("image references resolve through the context record to the message attachment", () => {
  const image = { id: "attachment-1", name: "shot.png", mimeType: "image/png", sizeBytes: 42, type: "image" };
  const records = parseContextRecords({ records: [{ contextId: "image_1", kind: "image", label: "shot", attachmentId: image.id }] });
  expect(withAnnotationImages(records, [image]).image_1.annotationImage).toEqual(image);
});

test("label falls back from the written text to the record to the kind; known kinds have an accent", () => {
  expect(chipLabel("  ", { contextId: "x", kind: "mention", label: "", path: "src/deep/a.ts" }, "mention")).toBe("a.ts");
  expect(chipLabel("Shown", undefined, "skill")).toBe("Shown");
  expect(chipLabel("", undefined, "skill")).toBe("skill");
  // The ink is solved per theme (contextChipVariables), so only its shape is fixed here.
  expect(chipColor("thread")).toMatch(/^#[0-9a-f]{6}$/);
  expect(chipColor("unknown-kind")).toBe(null);
});

test("review-comment records keep their card fields and a diff comment becomes a one-file patch", () => {
  const records = parseContextRecords({ records: [{ contextId: "r1", kind: "review-comment", label: "a.ts L2", sectionTitle: "File comment", filePath: "src/a.ts", rangeLabel: "L2", text: "why", diff: "two", fenceLanguage: "ts" }] });
  expect(records.r1).toMatchObject({ sectionTitle: "File comment", filePath: "src/a.ts", rangeLabel: "L2", diff: "two", fenceLanguage: "ts" });
  expect(records.r1!.hasPullRequest).toBeUndefined();
  expect(buildReviewCommentRenderablePatch({ filePath: "src/a.ts", diff: "two", fenceLanguage: "ts" })).toBe("");
  expect(buildReviewCommentRenderablePatch({ filePath: "src\\a.ts", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n\n" })).toBe("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b");
  expect(buildReviewCommentRenderablePatch({ filePath: "x", diff: "diff --git a/x b/x\n+1", fenceLanguage: "diff" })).toBe("diff --git a/x b/x\n+1");
  expect(buildReviewCommentRenderablePatch({ filePath: "x", diff: "  " })).toBe("");
});

test("fm13: a preview annotation chip reads its record and finds its screenshot among the message's images", () => {
  const records = parseContextRecords({ records: [
    { contextId: "preview-annotation_a1", kind: "preview-annotation", label: "Make it red", annotationId: "a1", pageUrl: "http://localhost:5173/", pageTitle: "App", comment: "Make it red", targetSummary: "1 selected element",
      styleChanges: ["color: (unset) → red"], elements: [{ tagName: "button", selector: "button#go", htmlPreview: "<button>", source: { fileName: "App.tsx", lineNumber: 4 } }] },
  ] });
  const r = records["preview-annotation_a1"]!;
  expect(r.comment).toBe("Make it red");
  expect(r.styleChangeCount).toBe(1);
  expect(r.annotationElements).toEqual([{ tagName: "button", selector: "button#go", htmlPreview: "<button>", sourceLabel: "App.tsx:4" }]);
  const image = { id: "img1", name: "preview-annotation-a1.png", mimeType: "image/png", sizeBytes: 10, type: "image" };
  expect(withAnnotationImages(records, [{ id: "x", name: "other.png", mimeType: "image/png", sizeBytes: 1, type: "image" }, image])["preview-annotation_a1"]!.annotationImage).toEqual(image);
  expect(withAnnotationImages(records, [])["preview-annotation_a1"]!.annotationImage).toBe(undefined);
});
