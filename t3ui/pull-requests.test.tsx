import { expect, open, test } from "nsh/test";

test("rows show state, number, title, author, repository and time, grouped as the web groups them", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  const shown = app.texts();
  await expect(shown).toContain("#1");
  await expect(shown).toContain("octocat");
  await expect(shown).toContain("acme/t3code");
  await expect(shown).toContain("5m ago");
  await expect(shown).toContain("bug");
  await expect(shown).toContain("Authored");
  await expect(shown).toContain("Review requested");
  await expect(shown).toContain("Others");
  await expect(shown).toContain("+10");
  await expect(shown).toContain("-2");
});

test("the state filter narrows rows locally and asks the server for that state", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await expect(app.texts()).not.toContain("Already merged");
  await app.press("label:Filters");
  await app.press("label:State filter");
  await app.press("label:State Merged");
  await app.waitFor("text:Already merged");
  await expect(app.texts()).not.toContain("Needs my review");
});

test("search filters rows by text and the draft filter by draft state", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.type("label:Search pull requests", "needs");
  // The typed text goes to the server, which answers with the rows that match it.
  await app.waitFor("text:asked:needs");
  await app.waitUntil(() => !app.texts().includes("Draft work"));
  await expect(app.texts()).toContain("Needs my review");
  await app.clear("label:Search pull requests");
  await app.press("label:Filters");
  await app.press("label:Draft filter");
  await app.press("label:Draft Drafts only");
  await app.waitUntil(() => !app.texts().includes("Needs my review"));
  await expect(app.texts()).toContain("Draft work");
});

test("load more pages with the server's next cursors and merges the rows", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Load more pull requests");
  await app.waitFor("text:Second page");
  await expect(app.texts()).toContain("Pull request 1");
});

test("selecting a row opens the detail with summary, timeline and code tabs", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await expect(app.texts()).toContain("Reviewers");
  await expect(app.texts()).toContain("hubot");
  // The Checks section starts collapsed, as the web's does.
  await expect(app.texts()).not.toContain("build");
  await app.press("label:Checks section");
  await app.waitFor("text:build");
  await app.press("label:Timeline");
  // Plain comments sit behind a disclosure each (here a thread falls between them), closed until opened (ConversationGroup).
  await app.press("label:1 comment >> nth=0");
  await app.press("label:1 comment >> nth=1");
  await app.waitFor("text:Looks good");
  await expect(app.texts()).toContain("Pull request opened");
  await app.press("label:Code");
  await app.waitFor("text:2 files");
  await expect(app.texts()).toContain("src/race.ts");
  await expect(app.texts()).toContain("0 / 2");
  await expect(app.texts()).toContain("viewed");
});

test("pull request details have a separate tab strip with functional panel controls", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("label:Pull request tabs");
  await app.press("label:Add panel surface");
  await app.waitFor("label:Add Browser");
  await app.press("label:Add panel surface");
  await app.press("label:Maximize pull request panel");
  await app.waitFor("label:Restore pull request panel");
  await app.press("label:Restore pull request panel");
  await app.press("label:Collapse pull request panel");
  await expect(app.shows("label:Pull request tabs")).toBe(false);
});

test("opening several pull requests keeps their tabs and closing one activates its neighbour", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("label:Open pull request 1");
  await app.press("label:Open pull request acme/t3code #2");
  await app.waitFor("label:Open pull request 2");
  await app.press("label:Close pull request 2");
  await app.waitUntil(() => !app.shows("label:Open pull request 2"));
  expect(app.shows("label:Open pull request 1")).toBe(true);
  await app.waitFor("label:Open pull request #1 on host");
});

test("the Code tab renders the diff inline and records viewed files", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await app.press("label:Code");
  await app.waitFor("text:2 files");
  await expect(app.texts()).toContain("fixed line");
  // The tick is labelled "Viewed" alone, as in the reference; the first file is pressed.
  await app.press("label:Viewed >> nth=0");
  await app.waitFor("text:1 / 2");
  await app.press("label:Hide test files");
  await app.waitFor("text:1 file");
  await expect(app.texts()).toContain("1 test file hidden");
});

test("a failed list shows the unavailable state with Retry that reloads", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Fail the server");
  await app.press("label:Refresh pull requests");
  await app.waitFor("text:host unreachable Showing the last pull requests loaded.");
});

test("an empty list shows the illustrated empty state with its actions", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Empty the server");
  await app.press("label:Refresh pull requests");
  await app.waitFor("text:No pull requests");
  await expect(app.texts()).toContain("Pull requests from every project in this workspace appear here.");
  await expect(app.texts()).toContain("Check again");
});

async function openDetail() {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  return app;
}

test("detail checks icon opens check results without changing the layout", async () => {
  const app = await openDetail();
  await app.press("label:Pull request detail >> label:Checks: Some checks were not successful");
  await app.waitFor("label:Check details");
  await app.waitFor("text:lint");
  await app.press("label:Show all");
  await app.waitFor("text:build");
  await app.press("label:Pull request detail >> label:Checks: Some checks were not successful");
  await app.waitUntil(() => !app.shows("label:Check details"));
});

test("failing checks turn the primary control into auto-merge, which asks to confirm", async () => {
  const app = await openDetail();
  await app.press("label:Auto-merge");
  await app.waitFor("text:Confirm auto-merge?");
  await app.press("label:Confirm auto-merge?");
  await app.waitFor('text:pullRequests.runAction {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"action":"enable-auto-merge","mergeMethod":"merge"}');
});

test("Merge now in the actions menu confirms, then merges with the chosen method", async () => {
  const app = await openDetail();
  await app.press("label:More pull request actions");
  await app.press("label:Merge method squash");
  await app.press("label:Merge now");
  await app.waitFor("text:Confirm merge?");
  await app.press("label:Confirm merge?");
  await app.waitFor('text:pullRequests.runAction {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"action":"merge","mergeMethod":"squash"}');
});

test("the actions menu lists host actions and runs them", async () => {
  const app = await openDetail();
  await app.press("label:More pull request actions");
  await expect(app.texts()).toContain("Convert to draft");
  await expect(app.texts()).toContain("Copy link");
  await app.press("label:Convert to draft");
  await app.waitFor('text:pullRequests.runAction {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"action":"draft"}');
});

test("the timeline posts a comment and submits a review verdict", async () => {
  const app = await openDetail();
  await app.press("label:Timeline");
  // Plain comments sit behind a disclosure each (here a thread falls between them), closed until opened (ConversationGroup).
  await app.press("label:1 comment >> nth=0");
  await app.press("label:1 comment >> nth=1");
  await app.waitFor("text:Looks good");
  await app.type("label:Comment on this pull request", "Ship it");
  await app.press("label:Post comment");
  await app.waitFor('text:pullRequests.comment {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"body":"Ship it"}');
  await app.press("label:Review tab");
  await app.press("label:Approve");
  await app.press("label:Submit review");
  await app.waitFor('text:pullRequests.submitReview {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"verdict":"approve","body":"","comments":[]}');
});

test("the label picker applies a label through setLabels", async () => {
  const app = await openDetail();
  await app.press("label:Change labels");
  await app.waitFor("text:docs");
  await app.press("label:Label docs");
  await app.waitFor('text:pullRequests.setLabels {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"labels":["docs"],"applied":true}');
});

test("a row's checks icon opens the checks list, failing first, finished behind Show all", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Needs my review");
  await app.press("label:Checks: Some checks were not successful");
  await app.waitFor("text:1 of 2 failing");
  await expect(app.texts()).toContain("lint");
  await expect(app.texts()).toContain("Details");
  await expect(app.texts()).toContain("Show all");
  await app.press("label:Show all");
  await expect(app.texts()).toContain("Show less");
});

test("the Guide tab offers to write a guide, then tours its stops", async () => {
  const app = await openDetail();
  await app.press("label:Guide");
  await app.waitFor("text:No review guide yet");
  await app.press("label:Write guide");
  await app.waitFor("text:Stop 1 of 2");
  await expect(app.texts()).toContain("The race");
  await expect(app.texts()).toContain("A risk to judge");
  await expect(app.texts()).toContain("src/race.ts");
  // The excerpt draws the diff lines in its range, read from the pull request's diff.
  await app.waitFor("text:fixed line");
  await expect(app.texts()).toContain("Questions to consider");
  await app.press("label:Next stop");
  await app.waitFor("text:Stop 2 of 2");
  await expect(app.texts()).toContain("Files in this stop");
});

test("fm13: J and K step the guide tour (GuideTour keyboard stepping)", async () => {
  const app = await openDetail();
  await app.press("label:Guide");
  await app.waitFor("text:No review guide yet");
  await app.press("label:Write guide");
  await app.waitFor("text:Stop 1 of 2");
  await app.keyboard.press("j");
  await app.waitFor("text:Stop 2 of 2");
  await app.keyboard.press("k");
  await app.waitFor("text:Stop 1 of 2");
});

test("a stacked pull request lists its layers and opens another layer", async () => {
  const app = await openDetail();
  await app.press("label:Stack 1, layer 1 of 2");
  await app.waitFor("text:Stack #1");
  await expect(app.texts()).toContain("Follow-up layer");
  await expect(app.texts()).toContain("↳ main");
  await app.press("label:Stack layer #5");
  await app.waitFor("label:Open pull request #5 on host");
});

test("the pencil renames the title through pullRequests.update", async () => {
  const app = await openDetail();
  await app.press("label:Edit title");
  await app.type("label:Pull request title", " (fixed)");
  await app.press("label:Save title");
  await app.waitFor('text:pullRequests.update {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"title":"Pull request 1 (fixed)"}');
});

test("Cancel leaves the title alone", async () => {
  const app = await openDetail();
  await app.press("label:Edit title");
  await app.press("label:Cancel title edit");
  await expect(app.texts()).toContain("Pull request 1");
  await expect(app.texts()).not.toContain("Save");
});

test("the reviewer picker lists people with access and requests a review", async () => {
  const app = await openDetail();
  await app.press("label:Request a review");
  await app.waitFor("text:mona");
  await app.waitFor("text:team");
  await expect(app.texts()).toContain("This repository has more people with access than are listed here. Ask for the rest on the host.");
  await app.type("label:Search people with access", "mon");
  await expect(app.texts()).not.toContain("core");
  await app.press("label:Reviewer mona");
  await app.waitFor('text:pullRequests.requestReviewers {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"reviewers":[{"id":"u2","kind":"user"}],"requested":true}');
});

test("fm13: the reviewer picker highlights the first person and Enter requests a review (combobox autoHighlight)", async () => {
  const app = await openDetail();
  await app.press("label:Request a review");
  await app.waitFor("text:mona");
  await app.type("label:Search people with access", "mon");
  await app.keyboard.press("enter");
  await app.waitFor('text:pullRequests.requestReviewers {"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1,"reviewers":[{"id":"u2","kind":"user"}],"requested":true}');
});

test("disconnected, the page explains the connection and links to environment settings", async () => {
  const app = await open("./PullRequestsDisconnectedFixture.tsx", { width: 1280, height: 900 });
  await expect(app.texts()).toContain("Connect an environment");
  await expect(app.shows("label:Open environment settings")).toBe(true);
});

const BASE = '"projectId":"p1","host":"github.com","repository":"acme/t3code","number":1';

async function openCode() {
  const app = await openDetail();
  await app.press("label:Code");
  await app.waitFor("text:2 files");
  return app;
}

test("a host review thread sits under its diff line with its comments, reactions and edit pencil", async () => {
  const app = await openCode();
  await app.waitFor("text:Is this guard enough?");
  await expect(app.texts()).toContain("Open · 3 comments");
  await expect(app.texts()).toContain("Yes, the lock covers it.");
  await expect(app.shows("label:thumbs up, 1")).toBe(true);
  // Only the viewer's own comment is editable.
  await expect(app.count("label:Edit comment")).toBe(1);
});

test("threads off the current diff are listed apart, collapsed until opened", async () => {
  const app = await openCode();
  await app.waitFor("text:Conversations not on the current diff");
  await expect(app.texts()).not.toContain("Outdated remark");
  await app.press("label:Conversations not on the current diff");
  await app.waitFor("text:Outdated remark");
  await expect(app.texts()).toContain("src/gone.ts");
});

test("Reply posts through replyToThread, Resolve through setThreadResolution", async () => {
  const app = await openCode();
  await app.waitFor("text:Is this guard enough?");
  await app.press("label:Reply");
  await app.type("label:Reply to this conversation", "Thanks");
  await app.press("label:Reply");
  await app.waitFor(`text:pullRequests.replyToThread {${BASE},"threadId":"t1","body":"Thanks"}`);
  await app.press("label:Resolve");
  await app.waitFor(`text:pullRequests.setThreadResolution {${BASE},"threadId":"t1","resolved":true}`);
});

test("Load more comments reads the next page of the thread", async () => {
  const app = await openCode();
  await app.waitFor("text:Is this guard enough?");
  await app.press("label:Load more comments");
  await app.waitFor("text:A third reply");
  await expect(app.shows("label:Load more comments")).toBe(false);
});

test("a reaction pill toggles through setReaction", async () => {
  const app = await openCode();
  await app.waitFor("text:Is this guard enough?");
  await app.press("label:thumbs up, 1");
  await app.waitFor(`text:pullRequests.setReaction {${BASE},"subjectId":"rc1","content":"thumbs-up","reacted":true}`);
});

test("a line comment is added to the pending review and sent with the verdict", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900, platform: "macos" });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await app.press("label:Code");
  await app.waitFor("text:2 files");
  await app.hover("text:old line");
  await app.press("label:Add a comment on this line");
  await app.waitFor("text:src/race.ts:2");
  await app.type("label:Line comment", "Why remove this?");
  await app.press("label:Add to review");
  await app.waitFor("text:Pending. Sent when you submit the review");
  await expect(app.texts()).toContain("Why remove this?");
  await app.press("label:Timeline");
  await app.press("label:Review tab");
  await app.press("label:Submit review");
  await app.waitFor(`text:pullRequests.submitReview {${BASE},"verdict":"comment","body":"","comments":[{"path":"src/race.ts","position":{"kind":"deleted","oldLine":2},"body":"Why remove this?"}]}`);
});

test("the description renders as markdown, has reactions, and its pencil saves through update", async () => {
  const app = await openDetail();
  await expect(app.texts()).toContain("Summary");
  await app.waitFor("label:heart, 2");
  await app.press("label:heart, 2");
  await app.waitFor(`text:pullRequests.setReaction {${BASE},"content":"heart","reacted":true}`);
  await app.press("label:Edit description");
  await app.type("label:Pull request description", " More.");
  await app.press("label:Save");
  await app.waitFor(`text:pullRequests.update {${BASE},"body":"## Summary\\n\\nFixes the race.\\n\\n- one\\n- two More."}`);
});

test("only the viewer's own timeline comment can be edited, through updateComment", async () => {
  const app = await openDetail();
  await app.press("label:Timeline");
  // Plain comments sit behind a disclosure each (here a thread falls between them), closed until opened (ConversationGroup).
  await app.press("label:1 comment >> nth=0");
  await app.press("label:1 comment >> nth=1");
  await app.waitFor("text:Looks good");
  // The viewer's own timeline comment and their own reply inside the review thread (now shown in the timeline) have pencils; hubot's do not.
  await expect(app.count("label:Edit comment")).toBe(2);
  await app.press("label:Edit comment >> nth=0");
  await app.type("label:Edit comment >> nth=1", "!");
  await app.press("label:Save");
  await app.waitFor(`text:pullRequests.updateComment {${BASE},"commentId":"c2","kind":"issue-comment","body":"My own **note**!"}`);
});

test("the header's crumbs show the repository and number, with the checkout command to copy", async () => {
  const app = await openDetail();
  await expect(app.shows("label:Open pull request #1 on host")).toBe(true);
  await expect(app.shows("label:Open acme/t3code repository")).toBe(true);
  await expect(app.texts()).toContain("gh pr checkout 1");
  await expect(app.texts()).toContain("3 files");
  await app.press("label:Copy checkout command");
  await app.waitFor("label:Checkout command copied");
});

test("Check out in a worktree prepares the branch on the server, opens a thread on it and says so", async () => {
  const app = await openDetail();
  await app.press("label:Check out");
  await app.press("label:In a separate worktree");
  await app.waitFor('text:workspace {"type":"existing_worktree","worktreePath":"/wt/feature-1","branch":"feature-1"}');
  await expect(app.texts()).toContain("Checked out");
});

test("Check out in this repository switches the repository's branch", async () => {
  const app = await openDetail();
  await app.press("label:Check out");
  await app.press("label:In this repository");
  await app.waitFor('text:workspace {"type":"root","branch":"feature-1"}');
  await expect(app.texts()).toContain("Checked out here");
});

test("Shift over the list reveals each row's quick actions, and Merge runs the host's first merge method at once", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await expect(app.shows("label:Merge #1")).toBe(false);
  await app.press("label:Hold shift");
  await app.waitFor("label:Merge #1");
  // A draft offers Ready for review, not Merge.
  await expect(app.shows("label:Ready for review #3")).toBe(true);
  await expect(app.shows("label:Merge #3")).toBe(false);
  await app.press("label:Merge #1");
  // client-runtime pullRequests.ts runAction: every action asks for the summary reply.
  await app.waitFor(`text:pullRequests.runAction {${BASE},"action":"merge","mergeMethod":"merge","replyWithSummary":true}`);
});

test("a pull request behind its base warns, and Update with rebase runs the update-branch action", async () => {
  const app = await openDetail();
  await app.press("label:This branch is out-of-date with main by 2 commits.");
  await app.waitFor("text:Changes can be cleanly merged.");
  await expect(app.shows("label:Update branch")).toBe(false);
  await app.press("label:Update with rebase");
  await app.waitFor(`text:pullRequests.runAction {${BASE},"action":"update-branch","updateMethod":"rebase"}`);
});


test("qualifiers typed in the search box go to the server as filters, and Enter sends them at once", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.type("label:Search pull requests", "needs author:hubot");
  await app.waitFor("text:asked:needs");
  await app.submit("label:Search pull requests");
  await app.waitFor("text:Needs my review");
  // The author qualifier narrows the rows held locally while the request is in flight, as the web's does.
  await expect(app.texts()).not.toContain("Draft work");
});

test("rows the host answered for the typed text are not narrowed again locally", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  // The host also searches bodies, so it returns a row whose title lacks the text: nothing here may hide it.
  await app.type("label:Search pull requests", "inthebody");
  await app.waitFor("text:Unrelated title");
});

test("the saved list choices are restored before the first request, and changes are saved", async () => {
  const saved = JSON.stringify({ involvement: "reviewing", state: "all", sort: "newest" });
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900, storage: { "t3.pullRequests.preferences": saved } });
  await app.waitFor("text:Needs my review");
  // The Reviewing tab and the All state were asked for from the start.
  await expect(app.texts()).not.toContain("Draft work");
  await app.press("label:Filters");
  await app.press("label:Draft filter");
  await app.press("label:Draft Drafts only");
  await app.waitUntil(() => JSON.parse(app.storage()["t3.pullRequests.preferences"] ?? "{}").draft === "only");
  expect(JSON.parse(app.storage()["t3.pullRequests.preferences"] ?? "{}")).toMatchObject({ involvement: "reviewing", state: "all", sort: "newest", draft: "only" });
});

test("the header counts the threads linked to the pull request, archived ones too, and opens them", async () => {
  const app = await openDetail();
  await app.waitFor("label:Linked from 2 threads");
  await app.press("label:Linked from 2 threads");
  // The web opens the command palette on the pull request URL, with its linked threads as rows.
  await app.waitFor("text:Linked thread");
  await expect(app.texts()).toContain("Fix the race");
  await expect(app.texts()).toContain("Navigate");
  // The reference counts an archived thread and lists it as "Archived thread".
  await expect(app.texts()).toContain("Archived one");
  await expect(app.texts()).toContain("Archived thread");
});

test("Link to thread picks a thread by search and sends the link command; a thread already linked is marked", async () => {
  const app = await openDetail();
  await app.press("label:More pull request actions");
  await app.press("label:Link to thread");
  await app.waitFor("label:Search threads or projects");
  await expect(app.texts()).toContain("Linked");
  await app.type("label:Search threads or projects", "unrel");
  await expect(app.texts()).not.toContain("Fix the race");
  await app.press("label:Link thread Unrelated chat");
  await app.waitFor('text:orchestration.dispatchCommand {"type":"thread.pull-request.link","threadId":"thread:b","host":"github.com","repository":"acme/t3code","number":1,"url":"https://github.com/acme/t3code/pull/1","source":"manual"}');
});

test("Ask a question and Explain open a thread whose composer holds the pull request and the task", async () => {
  const app = await openDetail();
  await app.press("label:More pull request actions");
  await app.press("label:Ask a question");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("draft The pull request is #1, titled `Pull request 1`, at `https://github.com/acme/t3code/pull/1`.")));
  await app.press("label:More pull request actions");
  await app.press("label:Explain this PR");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("draft Explain this pull request.  The pull request is #1")));
});

test("a conflicting pull request offers Resolve conflicts, which checks out a worktree and drafts the task", async () => {
  const app = await openDetail();
  await app.press("label:Stack 1, layer 1 of 2");
  await app.press("label:Stack layer #5");
  await app.waitFor("label:Resolve conflicts");
  await app.press("label:Resolve conflicts");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("draft PR #5 (https://github.com/acme/t3code/pull/5) conflicts with its base branch `main`.")));
});

test("Authored and Review requested hold the hosts' own answers for those involvements, even for rows the main page lacks", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  // Neither older row is in the recency page; each comes from its partition query.
  await app.waitFor("text:Older authored work");
  await expect(app.texts()).toContain("Older review request");
});

test("a typed search asks only the main query, so the groups fall back to the rows it returned", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.type("label:Search pull requests", "needs");
  await app.waitFor("text:Needs my review");
  await expect(app.texts()).not.toContain("Older authored work");
});

test("the Project filter scopes the list, asks the server for that project and saves the scope with the other choices", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Filters");
  await app.press("label:Project filter");
  await app.press("label:Project docs-site");
  await app.waitFor("text:Docs page");
  await expect(app.texts()).not.toContain("Pull request 1");
  await app.waitUntil(() => JSON.parse(app.storage()["t3.pullRequests.preferences"] ?? "{}").projectId === "p2");
});

test("a project scope that was saved is applied from the first request", async () => {
  const saved = JSON.stringify({ involvement: "all", state: "open", projectId: "p2", environmentId: "env-1" });
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900, storage: { "t3.pullRequests.preferences": saved } });
  await app.waitFor("text:Docs page");
  await expect(app.texts()).not.toContain("Pull request 1");
  await app.waitUntil(() => JSON.parse(app.storage()["t3.pullRequests.preferences"] ?? "{}").environmentId === "env-1");
});

test("on a host without inline comments a diff selection goes to the agent, with the lines it covers", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900, platform: "macos" });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Disable inline comments");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await app.press("label:Code");
  await app.waitFor("text:2 files");
  await app.hover("text:old line");
  await app.press("label:Add a comment on this line");
  await app.waitFor("text:src/race.ts:2");
  await expect(app.shows("label:Add to review")).toBe(false);
  await app.type("label:Line comment", "Is this safe to drop?");
  await app.press("label:Add to agent");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("draft Is this safe to drop?  The pull request is #1")));
  const draft = app.texts().find((text) => text.startsWith("draft Is this safe to drop?")) ?? "";
  expect(draft).toContain("line 2 of `src/race.ts`");
  expect(draft).toContain("-old line");
});

test("with inline comments, Add to agent sits beside Add to review and the review comment is not added", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900, platform: "macos" });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await app.press("label:Code");
  await app.waitFor("text:2 files");
  await app.hover("text:fixed line");
  await app.press("label:Add a comment on this line");
  await app.type("label:Line comment", "Explain this change");
  await expect(app.shows("label:Add to review")).toBe(true);
  await app.press("label:Add to agent");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("draft Explain this change")));
  await expect(app.texts()).not.toContain("Pending. Sent when you submit the review");
});

test("typing @ in the comment box lists the host's users, and choosing one completes the mention", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await app.press("label:Timeline");
  await app.type("label:Comment on this pull request", "thanks @mo");
  await app.waitFor("label:Complete @mona");
  await expect(app.shows("label:Complete @octocat")).toBe(false);
  await app.waitFor("text:options authors mo");
  await app.press("label:Complete @mona");
  await app.waitUntil(() => app.value("label:Comment on this pull request") === "thanks @mona ");
});

test("typing # lists the host's issues and change requests", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await app.press("label:Timeline");
  await app.type("label:Comment on this pull request", "see #4");
  await app.waitFor("label:Complete #41");
  await app.waitFor("label:Complete #42");
  await expect(app.texts()).toContain("Crash on start");
});

test("Mod+Return posts the comment", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900, platform: "macos" });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await app.press("label:Timeline");
  await app.type("label:Comment on this pull request", "Looks right");
  await app.keyboard.press("mod+enter");
  await app.waitFor(`text:pullRequests.comment {${BASE},"body":"Looks right"}`);
});

test("a host holding workflow runs offers Approve workflows to run, which asks to confirm and sends the action", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await expect(app.shows("label:Approve workflows to run")).toBe(false);
  await app.press("label:Hold workflows");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("text:Fixes the race.");
  await app.press("label:Approve workflows to run");
  await expect(app.shows("label:Confirm approve?")).toBe(true);
  await app.press("label:Confirm approve?");
  await app.waitFor(`text:pullRequests.runAction {${BASE},"action":"approve-workflows"}`);
});

test("Allow edits from maintainers saves through update and shows the choice at once", async () => {
  const app = await openDetail();
  await app.press("label:More pull request actions");
  await expect(app.texts()).toContain("Allow edits from maintainers");
  await expect(app.texts()).toContain("Maintainers can push to this branch. If your fork has workflows, this can also give access to its secrets.");
  await app.press("label:Allow edits from maintainers");
  await app.waitFor(`text:pullRequests.update {${BASE},"maintainerCanModify":true}`);
});

test("a refused maintainer-edits save says so in a toast and keeps the earlier value", async () => {
  const app = await openDetail();
  await app.press("label:Fail the next save");
  await app.press("label:More pull request actions");
  await app.press("label:Allow edits from maintainers");
  await app.waitFor("text:Could not save maintainer access");
});

test("Fix findings in a thread checks out a worktree, then drafts every unresolved thread and failing check", async () => {
  const app = await openDetail();
  await app.press("label:More pull request actions");
  await app.press("label:Fix findings in a thread");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("draft Fix the actionable findings on PR #1")));
  const draft = app.texts().find((text) => text.startsWith("draft Fix the actionable findings")) ?? "";
  expect(draft).toContain("`src/race.ts` L2:");
  expect(draft).toContain("hubot: Is this guard enough?");
  expect(draft).toContain("Failing checks:");
  expect(draft).toContain("lint");
  expect(draft).not.toContain("Outdated remark: resolved");
});

test("a failing check on the Summary tab has its own Fix, and a review conversation on the Code tab offers Fix in a thread", async () => {
  const app = await openDetail();
  await app.press("text:Checks");
  await app.press("label:Fix lint");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("draft Fix the failing check quoted below.")));
  await app.press("label:Code");
  await app.waitFor("text:2 files");
  await app.press("label:Fix in a thread");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("draft Fix the review finding quoted below")));
});

test("dragging from a row's Close across the rows below closes each open one there, with one toast", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Hold shift");
  await app.waitFor("label:Close #1");
  // The fixture lists #1 and #11 in the Authored group; the drag ends on #11.
  await app.drag("label:Close #1", { y: 100 });
  await app.waitFor("text:Closed 2 pull requests");
});
