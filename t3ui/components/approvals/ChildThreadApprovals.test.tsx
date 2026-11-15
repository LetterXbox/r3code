import { expect, open, test } from "nsh/test";
import { childApprovalEntries } from "./ChildThreadApprovals";

test("only children waiting on an approval contribute, each approval with its child", () => {
  const approval = (id: string) => ({ id, kind: "command", title: "", detail: id, decisions: [], options: [] });
  const entries = childApprovalEntries(
    [{ id: "a", title: "Sub A", hasPendingApprovals: true }, { id: "b", title: "Side B", hasPendingApprovals: false }],
    (threadId) => threadId === "a" ? [approval("r1"), approval("r2")] : [approval("never")],
  );
  expect(entries.map((entry) => `${entry.title}:${entry.approval.id}`)).toEqual(["Sub A:r1", "Sub A:r2"]);
});

test("the parent answers a child's approval, and sees its failure and a gone provider", async () => {
  const app = await open("./ChildApprovalFixture.tsx", { width: 700, height: 500 });
  await expect(app.texts()).toContain("Approval needed from Review subagent");
  await expect(app.texts()).toContain("pnpm test");
  await expect(app.texts()).toContain("Terminal");
  await expect(app.texts()).toContain("Needs network");
  await app.press("label:Approve");
  await app.waitFor("text:answered child-1:req-1:accept");
  await app.press("label:Fail next");
  await app.press("label:Decline");
  await app.waitFor("text:Connection lost");
  await app.press("label:Make gone");
  await expect(app.texts()).toContain("Provider process is gone. Interrupt or restart the child thread to respond.");
  await expect(app.enabled("label:Approve")).toBe(false);
});
