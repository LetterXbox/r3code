import { expect, test } from "nsh/test";
import { configureBackend, createThread, openThread, sidebarDrafts, threadHasUnsentDraft } from "../../store";
import { attachExtraContext, threadContextRecord } from "./contextChips";

test("a draft holding only a context chip counts as user content (composerDraftHasUserContent)", () => {
  configureBackend("ws://127.0.0.1:37911/ws");
  createThread(null);
  const id = openThread()?.id ?? "";
  expect(sidebarDrafts().some((draft) => draft.id === id)).toBe(false);
  expect(threadHasUnsentDraft(id)).toBe(false);
  attachExtraContext(id, threadContextRecord({ environmentId: "env", threadId: "other" }, "Other thread"));
  expect(sidebarDrafts().some((draft) => draft.id === id)).toBe(true);
  expect(threadHasUnsentDraft(id)).toBe(true);
});
