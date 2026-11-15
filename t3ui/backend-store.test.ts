import { expect, test } from "nsh/test";
import { backendStatus, composerDraft, configureBackend, createThread, openThread, setComposerDraft } from "./store";

test("invalid and changed environments preserve drafts without exposing them across environments", () => {
  createThread(null);
  const originalId = openThread()?.id;
  setComposerDraft("unsent private draft");
  configureBackend("not a URL");
  expect(openThread()?.id).toBe(originalId);
  expect(composerDraft()).toBe("unsent private draft");
  configureBackend("ws://127.0.0.1:3777/ws");
  expect(backendStatus()).toBe("disconnected");
  expect(openThread()?.id).toBe(originalId);
  expect(composerDraft()).toBe("unsent private draft");
  configureBackend("ws://127.0.0.1:4777/ws");
  expect(openThread()).toBe(undefined);
  expect(composerDraft()).toBe("");
  configureBackend("ws://127.0.0.1:3777/ws");
  expect(openThread()?.id).toBe(originalId);
  expect(composerDraft()).toBe("unsent private draft");
  configureBackend("");
});
