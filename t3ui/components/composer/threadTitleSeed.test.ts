import { expect, test } from "nsh/test";
import { deriveThreadTitleSeed, sendTitleFallbackLabels } from "./threadTitleSeed";

test("title seed follows text, images, files, then context labels", () => {
  expect(deriveThreadTitleSeed({ text: "  fix   the [#12](t3-context://v1/review-comment/abc) bug ", attachments: [] })).toBe("fix the #12 bug");
  expect(deriveThreadTitleSeed({ text: "x".repeat(60), attachments: [] })).toBe(`${"x".repeat(50)}...`);
  expect(deriveThreadTitleSeed({ text: "", attachments: [{ kind: "image", name: "a.png" }] })).toBe("Attached image");
  expect(deriveThreadTitleSeed({ text: "", attachments: [{ kind: "image", name: "a.png" }, { kind: "image", name: "b.png" }] })).toBe("Attached images");
  expect(deriveThreadTitleSeed({ text: "", attachments: [{ kind: "file", name: "notes.txt" }] })).toBe("File: notes.txt");
  expect(deriveThreadTitleSeed({ text: "", attachments: [], fallbackLabels: sendTitleFallbackLabels([{ kind: "review-comment", label: "#4" }]) })).toBe("Review: #4");
  expect(deriveThreadTitleSeed({ text: "", attachments: [] })).toBe("New thread");
});
