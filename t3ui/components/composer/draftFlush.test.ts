import { Storage } from "nsh";
import { expect, test } from "nsh/test";
import { configureBackend, createThread, flushPendingDraftSave, setComposerDraft } from "../../store";

test("a pending draft save writes at once on flush (composerDraftStore flush on unload)", async () => {
  configureBackend("ws://127.0.0.1:37912/ws");
  createThread(null);
  setComposerDraft("flush me before quit");
  flushPendingDraftSave();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await Storage.getItem("draftStates"))?.includes("flush me before quit")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect((await Storage.getItem("draftStates")) ?? "").toContain("flush me before quit");
});
