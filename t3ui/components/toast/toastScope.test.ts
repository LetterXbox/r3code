// Thread-scoped toasts (ui/toast.tsx shouldRenderThreadScopedToast, GitActionsControl's `data.threadRef`): a toast raised with a threadRef shows
// only while that thread is the open one; one without shows everywhere.
import { expect, test } from "nsh/test";
import { clearToasts, setActiveThreadReader, shouldRenderThreadScopedToast, showToast, visibleToasts } from "./toastState";

test("a toast without a thread shows everywhere; one with a thread only on it", () => {
  expect(shouldRenderThreadScopedToast({}, null)).toBe(true);
  expect(shouldRenderThreadScopedToast({}, { threadId: "a" })).toBe(true);
  expect(shouldRenderThreadScopedToast({ threadRef: { threadId: "a" } }, null)).toBe(false);
  expect(shouldRenderThreadScopedToast({ threadRef: { threadId: "a" } }, { threadId: "b" })).toBe(false);
  expect(shouldRenderThreadScopedToast({ threadRef: { threadId: "a" } }, { threadId: "a" })).toBe(true);
});

test("the environment is compared when both sides know it", () => {
  const toast = { threadRef: { threadId: "a", environmentId: "e1" } };
  expect(shouldRenderThreadScopedToast(toast, { threadId: "a", environmentId: "e2" })).toBe(false);
  expect(shouldRenderThreadScopedToast(toast, { threadId: "a", environmentId: "e1" })).toBe(true);
  expect(shouldRenderThreadScopedToast(toast, { threadId: "a" })).toBe(true);
});

test("the stack lists a thread's toast only while its thread is open", () => {
  clearToasts();
  let open: string | null = null;
  setActiveThreadReader(() => (open ? { threadId: open } : null));
  showToast({ id: "plain", title: "Everywhere", timeoutMs: 0 });
  showToast({ id: "scoped", type: "error", title: "Failed on a", timeoutMs: 0, threadRef: { threadId: "a" } });
  expect(visibleToasts().map((toast) => toast.id)).toEqual(["plain"]);
  open = "a";
  expect(visibleToasts().map((toast) => toast.id)).toEqual(["scoped", "plain"]);
  open = "b";
  expect(visibleToasts().map((toast) => toast.id)).toEqual(["plain"]);
  setActiveThreadReader(null);
  clearToasts();
});
