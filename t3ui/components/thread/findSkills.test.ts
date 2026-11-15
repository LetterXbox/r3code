import { expect, test } from "nsh/test";
import { skillDisplayNamesIn } from "./threadFind";

test("a $skill mention also matches its display name in find (useThreadFind skill labels)", () => {
  const skills = [{ name: "code-review", displayName: "Code Review" }, { name: "docs", displayName: null }];
  expect(skillDisplayNamesIn("please run $code-review now", skills)).toBe("Code Review");
  expect(skillDisplayNamesIn("$code-reviewer", skills)).toBe("");
  expect(skillDisplayNamesIn("no skills here", skills)).toBe("");
});

test("a provider without conversation rollback refuses Edit from here (useTimelineRewind)", async () => {
  const { rewindBlockedReason } = await import("./rewind");
  const thread = { id: "t", projectId: "p", title: "T", status: "idle", pinned: false, updatedAt: 0 } as never;
  expect(rewindBlockedReason(thread, true, false, false)).toBe("This provider does not support reverting conversation history. Start a new thread instead.");
  expect(rewindBlockedReason(thread, true, false, true)).toBe(null);
});
