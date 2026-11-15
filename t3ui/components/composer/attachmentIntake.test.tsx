import { expect, open, test } from "nsh/test";
import { fileAttachmentTooLargeMessage, foldPaste, insertedRun, nextPastedTextFileName, pastedTextDisposition, pasteFoldedToast } from "./attachmentIntake";

test("pastes of 32 KB or more fold into a pasted-text file; smaller ones stay inline", () => {
  expect(pastedTextDisposition({ text: "a".repeat(32 * 1024 - 1), canAttach: true })).toBe("inline");
  expect(pastedTextDisposition({ text: "a".repeat(32 * 1024), canAttach: true })).toBe("attachment");
  expect(pastedTextDisposition({ text: "a", canAttach: true, wouldExceedInputLimit: true })).toBe("attachment");
  expect(nextPastedTextFileName(["Pasted-Text.txt", "pasted-text-2.txt"])).toBe("pasted-text-3.txt");
  expect(insertedRun("ab cd", "ab XYZ cd")).toEqual({ start: 3, end: 3, text: "XYZ " });
  const fold = foldPaste({ before: "hi ", after: `hi ${"a".repeat(40_000)}`, maxInputChars: 120_000, canAttach: true, fileLimit: 50 * 1024 * 1024, reservedNames: [] });
  expect(fold.kind).toBe("attach");
  if (fold.kind === "attach") { expect(fold.name).toBe("pasted-text.txt"); expect(fold.file.size).toBe(40_000); }
  expect(foldPaste({ before: "", after: "a".repeat(40_000), maxInputChars: 120_000, canAttach: false, fileLimit: null, reservedNames: [] })).toEqual({ kind: "inline" });
  expect(foldPaste({ before: "", after: "a".repeat(40_000), maxInputChars: 120_000, canAttach: true, fileLimit: 1000, reservedNames: [] })).toEqual({ kind: "inline" });
  expect(foldPaste({ before: "", after: "a".repeat(130_000), maxInputChars: 120_000, canAttach: true, fileLimit: 1000, reservedNames: [] }).kind).toBe("refuse");
  expect(pasteFoldedToast("pasted-text.txt", 40_000, true)).toEqual({ title: "Large paste attached as pasted-text.txt", description: "40 KB · Use ⌘⇧V to keep a large paste inline." });
  expect(fileAttachmentTooLargeMessage("big.zip", 50 * 1024 * 1024)).toBe("'big.zip' exceeds the 50 MB attachment limit.");
});

test("a paste that cannot be attached and would overflow the prompt is refused and the prompt stays as it was", async () => {
  const app = await open("./PasteFoldFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "keep");
  await app.waitUntil(() => app.texts().includes("draft-length:4"));
  await app.paste("id:composer-prompt", { text: "a".repeat(121_000) });
  await app.waitUntil(() => app.texts().includes("toasts:Pasted text is too large for this message"));
  await app.wait(50);
  await expect(app.texts()).toContain("draft-length:4");
  // The editor's document was rebuilt from the prompt: the pasted run is gone from the view too.
  await expect(app.texts().some((text) => text.length > 1000)).toBe(false);
});
