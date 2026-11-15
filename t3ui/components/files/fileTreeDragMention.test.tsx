import { expect, open, test } from "nsh/test";
import { composerMentionFromTreePath, draggedMentions } from "./fileTreeDragMention";

test("a dragged row mentions itself, or the whole selection when it is in it; the root mentions nothing", () => {
  expect(composerMentionFromTreePath("src/")).toBe("[src](src)");
  expect(composerMentionFromTreePath("/")).toBe(null);
  expect(draggedMentions("a.ts", ["b.ts"])?.text).toBe("[a.ts](a.ts)");
  expect(draggedMentions("a.ts", ["a.ts", "lib/c.ts"])?.text).toBe("[a.ts](a.ts) [c.ts](lib/c.ts)");
});

test("dropping a Files row on the composer inserts its mention with a trailing space; a drop elsewhere does nothing", async () => {
  const app = await open("./FileDragFixture.tsx", { width: 900, height: 600 });
  await app.waitFor("label:readme.md");
  await app.drag("label:readme.md", { x: 40, y: 0 });
  await expect(app.texts()).toContain("dropped: ");
  await app.drag("label:readme.md", { x: 400, y: 0 });
  await app.waitFor("text:dropped: [readme.md](readme.md) ");
});

import { configureBackend, createThread, composerDraft, openThread } from "../../store";
import { attachedExtraContexts } from "../composer/contextChips";
import { dropThreadOnComposer, primeThreadDrop, registerMentionDropTarget } from "./fileTreeDragMention";

test("a thread dropped on the composer attaches as a thread context with its marker in the prompt; a drop elsewhere does not", async () => {
  configureBackend("ws://127.0.0.1:37912/ws");
  createThread(null);
  const id = openThread()?.id ?? "";
  let claimed = false;
  const node = { measure: async () => ({ pagePosition: { x: 100, y: 100 }, bounds: { size: { width: 400, height: 100 } } }) };
  registerMentionDropTarget(node as never, { setActive: (active) => { claimed = active; }, insert: () => true, onRejected: () => {} });
  primeThreadDrop();
  await Promise.resolve(); await Promise.resolve();
  expect(dropThreadOnComposer({ x: 20, y: 20 }, { id: "thread:other", title: "Other" }, "env-1")).toBe(false);
  expect(attachedExtraContexts(id)).toEqual([]);
  expect(dropThreadOnComposer({ x: 200, y: 150 }, { id: "thread:other", title: "Other" }, "env-1")).toBe(true);
  expect(claimed).toBe(false);
  expect(attachedExtraContexts(id).map((record) => record.kind)).toEqual(["thread"]);
  expect(composerDraft()).toContain("t3-context://v1/thread/");
});

import { attachedPullRequests } from "../composer/contextChips";
import { pullRequestDragHandlers } from "./fileTreeDragMention";

test("a linked pull request row dragged onto the composer attaches it as pull request context; unreported ones do not drag", async () => {
  configureBackend("ws://127.0.0.1:37913/ws");
  createThread(null);
  const id = openThread()?.id ?? "";
  const node = { measure: async () => ({ pagePosition: { x: 100, y: 100 }, bounds: { size: { width: 400, height: 100 } } }) };
  registerMentionDropTarget(node as never, { setActive: () => {}, insert: () => true, onRejected: () => {} });
  const pr = { number: 5, title: "Add x", url: "https://github.com/a/b/pull/5", headBranch: "x", baseBranch: "main", state: "open", isDraft: false };
  const none = pullRequestDragHandlers(() => null);
  none.onMouseMove({ pagePosition: { x: 10, y: 10 } }); none.onPanStart(); none.onPanEnd({ translation: { x: 190, y: 140 }, cancelled: false });
  expect(attachedPullRequests(id)).toEqual([]);
  const drag = pullRequestDragHandlers(() => pr);
  drag.onMouseMove({ pagePosition: { x: 10, y: 10 } }); drag.onPanStart();
  await Promise.resolve(); await Promise.resolve();
  drag.onPanEnd({ translation: { x: 190, y: 140 }, cancelled: false });
  expect(attachedPullRequests(id).map((record) => record.pullRequest.number)).toEqual([5]);
});
