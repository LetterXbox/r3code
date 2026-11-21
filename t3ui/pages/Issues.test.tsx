// UI tests for Issues page, IssueDetailPanel, comment posting, and standalone Linear tracker settings (#19259, #19274, #29387).
import { expect, open, test } from "nsh/test";

test("Issues page lists grouped trackers, opens IssueDetailPanel, posts comment, and configures Linear tracker (#19259, #19274)", async () => {
  const app = await open("./IssuesFixture.tsx", { width: 1200, height: 820 });
  await app.wait(120);

  expect(app.texts()).toContain("Native Linear sync");
  expect(app.texts()).toContain("Verify PR diff");

  // Open ENG-101 detail panel.
  await app.press("label:Open issue ENG-101: Native Linear sync");
  await app.wait(120);
  expect(app.texts()).toContain("Initial description for ENG-101");
  expect(app.texts()).toContain("alice added the parity label");

  // Post a comment through IssueCommentComposer.
  await app.type("label:Add a comment", "Verified in GPUI");
  await app.press("label:Send comment");
  await app.wait(120);
  expect(app.texts()).toContain("Verified in GPUI");

  // Switch to standalone IssueTrackerSettings, connect Linear token, and verify connected summary + project selector.
  await app.press("label:Issue tracker settings");
  await app.wait(120);
  expect(app.texts()).toContain("Issue trackers");
  await app.press("label:Toggle Linear details");
  await app.wait(60);
  await app.type("label:API key", "lin_api_test");
  await app.press("label:Save Linear credential");
  await app.wait(120);
  expect(app.texts().some((line) => line.includes("alice@co"))).toBe(true);
  expect(app.texts()).toContain("R3 Code");
  expect(app.texts()).toContain("Not bound");
  await app.press("label:Linear team for R3 Code = ");
  await app.wait(60);
  await app.press("label:Engineering (ENG)");
  await app.wait(120);
  expect(app.texts()).toContain("Engineering (ENG)");
  expect(app.texts().some((line) => line.includes("1 project linked"))).toBe(true);
});
