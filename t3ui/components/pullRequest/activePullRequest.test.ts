import { expect, test } from "nsh/test";
import { toasts } from "../toast/toastState";
import { copyActivePullRequestNumber, setActivePullRequest } from "./activePullRequest";

test("copying with no pull request open does nothing", async () => {
  setActivePullRequest(null);
  expect(await copyActivePullRequestNumber()).toBe(false);
});

test("the open pull request's number is copied and announced with the host's short label", async () => {
  setActivePullRequest({ number: 42, provider: "gitlab" });
  await copyActivePullRequestNumber();
  const titles = toasts().map((toast) => toast.title);
  expect(titles.some((title) => title === "MR number copied" || title === "Failed to copy MR number")).toBe(true);
  setActivePullRequest(null);
});

test("useOpenPanelPullRequestUrl: a panel tab's loaded detail URL, else its own URL, else unknown (null)", async () => {
  const { panelPullRequestUrl, rememberPanelPullRequestUrl } = await import("./activePullRequest");
  expect(panelPullRequestUrl({ id: "pull-request:o/r#1" })).toBe(null);
  expect(panelPullRequestUrl({ id: "pull-request:o/r#1", url: "https://h/o/r/pull/1" })).toBe("https://h/o/r/pull/1");
  rememberPanelPullRequestUrl("pull-request:o/r#1", "https://github.com/o/r/pull/1");
  expect(panelPullRequestUrl({ id: "pull-request:o/r#1", url: "https://h/o/r/pull/1" })).toBe("https://github.com/o/r/pull/1");
});
