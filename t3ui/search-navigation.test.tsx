import { expect, open, test } from "nsh/test";
import { searchResultTimelineIndex } from "./pages/ThreadView";
import { mergeTimeline } from "./components/thread/timeline";

test("search matches resolve by message ID and only fall back to a snippet when the ID is absent", () => {
  const entries = mergeTimeline([
    { id: "first", role: "assistant", body: "A different message about cache", order: 1 },
    { id: "wanted", role: "assistant", body: "The **Café** cache is ready", order: 2 },
  ], [{ id: "tool", type: "command_execution", title: "Command", detail: "pwd", status: "completed", order: 1.5 }]);
  const match = { threadId: "t", projectId: "p", source: "assistant" as const, snippet: "…Cafe cache is ready", messageId: "wanted" };
  const target = { environment: "", generation: 0, threadId: "t", query: "cache", match };
  expect(searchResultTimelineIndex(entries, target)).toBe(2);
  expect(searchResultTimelineIndex(entries, { ...target, match: { ...match, messageId: "not-loaded" } })).toBe(-1);
  expect(searchResultTimelineIndex(entries, { ...target, match: { ...match, messageId: null } })).toBe(2);
});

test("clicking a message result jumps after its transcript loads", async () => {
  const app = await open("./SearchNavigationFixture.tsx", { width: 850, height: 500 });
  await app.type("label:Search threads", "needle");
  await app.press("label:Open search result Matched thread");
  await app.waitFor("id:Selected search match");
  await expect(app.texts()).toContain("needle at message 12");
  await expect(app.value("label:Search threads")).toBe("");
});

test("submitting the first result from the search field jumps to the match", async () => {
  const app = await open("./SearchNavigationFixture.tsx", { width: 850, height: 500 });
  await app.type("label:Search threads", "needle");
  await app.submit("label:Search threads");
  await app.waitFor("id:Selected search match");
  await expect(app.texts()).toContain("needle at message 12");
});
