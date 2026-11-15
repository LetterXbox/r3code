import { expect, test } from "nsh/test";
import { configureBackend, renameThread } from "../../store";
import { toasts } from "../toast/toastState";

test("a rename the server refuses toasts Failed to rename thread (ChatHeader)", async () => {
  configureBackend("ws://127.0.0.1:37914/ws");
  renameThread("thread:missing", "New title");
  for (let attempt = 0; attempt < 200 && !toasts().some((toast) => toast.title === "Failed to rename thread"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(toasts().some((toast) => toast.title === "Failed to rename thread")).toBe(true);
});
