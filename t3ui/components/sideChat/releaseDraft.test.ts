import { expect, test } from "nsh/test";
import { composerDraftFor, releaseThreadDraft, setComposerDraft, withThreadScope } from "../../store";

test("deleting a side chat drops its draft", () => {
  withThreadScope("side-1", () => setComposerDraft("half typed"));
  expect(composerDraftFor("side-1")).toBe("half typed");
  releaseThreadDraft("side-1");
  expect(composerDraftFor("side-1")).toBe("");
});
