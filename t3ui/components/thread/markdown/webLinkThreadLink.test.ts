import { expect, test } from "nsh/test";
import { externalLinkMenuItems, threadPullRequestLinkAction } from "./MarkdownChips";

const base = { threadId: "thread:a", canOperate: true, supported: true, linked: [] as { host: string; repository: string; number: number }[] };

test("a pull request link offers Link to thread, or Unlink when the thread already has it (externalLinkContextMenu)", () => {
  const url = "https://github.com/Acme/App/pull/12";
  expect(threadPullRequestLinkAction(url, base)).toBe("link-to-thread");
  expect(threadPullRequestLinkAction(url, { ...base, linked: [{ host: "github.com", repository: "acme/app", number: 12 }] })).toBe("unlink-from-thread");
  expect(threadPullRequestLinkAction("https://example.com/docs", base)).toBe(undefined);
  expect(threadPullRequestLinkAction(url, { ...base, canOperate: false })).toBe(undefined);
  expect(threadPullRequestLinkAction(url, { ...base, supported: false })).toBe(undefined);
  expect(threadPullRequestLinkAction(url, { ...base, threadId: null })).toBe(undefined);
});

test("the thread link item leads the link menu", () => {
  const items = externalLinkMenuItems("https://github.com/a/b/pull/1", { openExternal: () => {}, openInApp: null, threadLink: { action: "unlink-from-thread", run: async () => {} } });
  expect(items.map((item) => ("label" in item ? item.label : "-"))).toEqual(["Unlink from thread", "Open in system browser", "Copy Link"]);
  const plain = externalLinkMenuItems("https://example.com", { openExternal: () => {}, openInApp: () => {} });
  expect(plain.map((item) => ("label" in item ? item.label : "-"))).toEqual(["Open in integrated browser", "Open in system browser", "Copy Link"]);
});
