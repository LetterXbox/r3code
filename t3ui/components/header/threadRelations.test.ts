import { expect, test } from "nsh/test";
import { guestShareLabel, pendingGuestMessages, parentBreadcrumbTitle, readLinkedPullRequests, threadRelationsFromShell } from "./threadRelations";

test("run forks preserve their source separately from the lineage parent", () => {
  const relations = threadRelationsFromShell({ lineage: { parentThreadId: "parent", relationshipToParent: "fork" }, forkedFrom: { type: "run", threadId: "source" } });
  expect(relations?.lineage?.parentThreadId).toBe("parent");
  expect(relations?.forkSourceThreadId).toBe("source");
});

test("only side chats and subagents link their parent", () => {
  expect(threadRelationsFromShell({ lineage: { parentThreadId: "p", relationshipToParent: "subagent" } })?.parentThreadId).toBe("p");
  expect(threadRelationsFromShell({ lineage: { parentThreadId: "p", relationshipToParent: null, sideChat: true } })?.parentThreadId).toBe("p");
  const fork = threadRelationsFromShell({ lineage: { parentThreadId: "p", relationshipToParent: "fork", rootThreadId: "r" } });
  expect(fork?.parentThreadId).toBe(null);
  expect(fork?.lineage).toEqual({ parentThreadId: "p", relationshipToParent: "fork", rootThreadId: "r", sideChat: false });
  expect(threadRelationsFromShell({})).toBeUndefined();
});

test("link origin and guest share come off the shell record", () => {
  const relations = threadRelationsFromShell({ linkOrigin: { sessionId: "s", label: "Work Mac" }, guestShare: { id: "g", guestName: "Ada", expiresAt: "2030-01-01T00:00:00Z", messages: [] } });
  expect(relations?.linkOrigin).toBe("Work Mac");
  expect(relations?.guestShare).toEqual({ id: "g", guestName: "Ada", expiresAt: "2030-01-01T00:00:00Z", messages: [] });
});

test("the guest share status names the guest, or says the link is active or expired", () => {
  const share = { id: "g", guestName: null, expiresAt: "2030-01-01T12:00:00Z" };
  expect(guestShareLabel(share, "2029-12-31T00:00:00Z")).toBe("Guest link active");
  expect(guestShareLabel({ ...share, guestName: "Ada" }, "2029-12-31T00:00:00Z")).toBe("Ada is a guest");
  expect(guestShareLabel(share, "2030-01-01T12:00:30Z")).toBe("Guest link expired");
  expect(parentBreadcrumbTitle(undefined)).toBe("Parent thread");
  expect(parentBreadcrumbTitle("Plan")).toBe("Plan");
});

test("linked pull requests come newest first, without dismissed stack members", () => {
  const links = readLinkedPullRequests([
    { host: "github.com", repository: "o/r", number: 1, url: "u1", source: "manual", linkedAt: "2030-01-01T00:00:00Z", snapshot: null },
    { host: "github.com", repository: "o/r", number: 2, url: "u2", source: "stack-dismissed", linkedAt: "2030-01-03T00:00:00Z", snapshot: null },
    { host: "github.com", repository: "o/r", number: 3, url: "u3", source: "agent", linkedAt: "2030-01-02T00:00:00Z", snapshot: { state: "open", title: "Add x", isDraft: false, headBranch: "x", baseBranch: "main", additions: 4, deletions: 1, changedFiles: 2 }, watch: { startedAt: "t" } },
  ]);
  expect(links.map((link) => link.number)).toEqual([3, 1]);
  expect(links[0]?.snapshot?.title).toBe("Add x");
  expect(links[0]?.watching).toBe(true);
  expect(links[1]?.snapshot).toBe(null);
  expect(threadRelationsFromShell({ pullRequests: [{ number: 1, url: "u", repository: "o/r", linkedAt: "t" }] })?.pullRequests?.length).toBe(1);
});

test("a guest share carries its messages, and only the pending ones wait for the owner", () => {
  const relations = threadRelationsFromShell({ guestShare: { id: "g", guestName: "Ada", expiresAt: "2030-01-01T00:00:00Z", messages: [
    { id: "m1", text: "Can you also add tests?", status: "pending", submittedAt: "2029-12-31T10:00:00Z", attachments: [{ id: "a1", name: "log.txt", mimeType: "text/plain", type: "file" }] },
    { id: "m2", text: "thanks", status: "sent", submittedAt: "2029-12-31T09:00:00Z" },
    { id: "m3", text: "bad", status: "weird", submittedAt: "" },
  ] } });
  expect(relations?.guestShare?.messages?.map((message) => message.id)).toEqual(["m1", "m2"]);
  expect(pendingGuestMessages(relations?.guestShare).map((message) => message.id)).toEqual(["m1"]);
  expect(relations?.guestShare?.messages?.[0]?.attachments).toEqual([{ id: "a1", name: "log.txt", mimeType: "text/plain", type: "file" }]);
  expect(pendingGuestMessages(null)).toEqual([]);
});

test("delegatedFrom names the parent thread on a linked environment", () => {
  const relations = threadRelationsFromShell({ delegatedFrom: { environmentId: "env-2", threadId: "p-1", title: "Plan the work" } });
  expect(relations?.delegatedFrom).toEqual({ environmentId: "env-2", threadId: "p-1", title: "Plan the work" });
  expect(threadRelationsFromShell({ delegatedFrom: null })).toBeUndefined();
});
