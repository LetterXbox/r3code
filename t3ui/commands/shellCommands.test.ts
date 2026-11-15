import { expect, test } from "nsh/test";
import { clearToasts, toasts } from "../components/toast/toastState";
import { bindComposerSendCommands, copyPullRequestNumber, pullRequestReference } from "./shellCommands";
import { hasCommandHandler, runCommand } from "./registry";
import type { Surface } from "../components/rightPanel/panelLogic";

const surface = (overrides: Partial<Surface> = {}): Surface => ({ id: "s1", kind: "pull-request", host: "github.com", repository: "octo/repo", number: 42, url: "https://github.com/octo/repo/pull/42", ...overrides });

test("the open pull request tab names its number and the host's short term", () => {
  expect(pullRequestReference(surface())).toEqual({ text: "#42", shortLabel: "PR" });
  expect(pullRequestReference(surface({ host: "gitlab.com", url: "https://gitlab.com/g/r/-/merge_requests/42" }))).toEqual({ text: "#42", shortLabel: "MR" });
  expect(pullRequestReference(surface({ kind: "terminal" }))).toBe(null);
  expect(pullRequestReference(surface({ number: undefined }))).toBe(null);
  expect(pullRequestReference(undefined)).toBe(null);
});

test("copying says '<PR> number copied', and a refused write says it failed with the reason", async () => {
  clearToasts();
  let written = "";
  await copyPullRequestNumber({ text: "#42", shortLabel: "PR" }, async (text) => { written = text; });
  expect(written).toBe("#42");
  expect(toasts()[0]).toMatchObject({ type: "success", title: "PR number copied" });
  clearToasts();
  await copyPullRequestNumber({ text: "#7", shortLabel: "MR" }, async () => { throw new Error("Clipboard is unavailable"); });
  expect(toasts()[0]).toMatchObject({ type: "error", title: "Failed to copy MR number", description: "Clipboard is unavailable" });
  clearToasts();
});

test("the composer send commands exist only while the composer has bound them", () => {
  expect(hasCommandHandler("composer.sendBackground")).toBe(false);
  const calls: string[] = [];
  const release = bindComposerSendCommands({ sendBackground: () => calls.push("background"), sendAndNewThread: () => calls.push("new") });
  expect(hasCommandHandler("composer.sendBackground")).toBe(true);
  expect(runCommand("composer.sendBackground")).toBe(true);
  expect(runCommand("composer.sendAndNewThread")).toBe(true);
  expect(calls).toEqual(["background", "new"]);
  release();
  expect(hasCommandHandler("composer.sendBackground")).toBe(false);
  expect(runCommand("composer.sendAndNewThread")).toBe(false);
});
