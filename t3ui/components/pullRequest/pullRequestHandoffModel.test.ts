import { expect, test } from "nsh/test";
import { createPullRequestHandoffModel } from "./pullRequestHandoffModel";

const subject = { number: 7, title: "Fix it", url: "https://github.com/o/r/pull/7", headBranch: "fix", baseBranch: "main", provider: "github", projectId: "p" };

test("beside a composer, handoffs go into it with 'Added to the composer' and the in-this-thread labels (fm13)", async () => {
  const drafts: string[] = [];
  const toasts: { title: string; description?: string }[] = [];
  let threads = 0;
  let checkouts = 0;
  const model = createPullRequestHandoffModel({
    subject: () => subject,
    newThread: () => { threads++; return "t"; },
    setDraft: (text) => drafts.push(text),
    checkout: async () => { checkouts++; return true; },
    toast: (input) => toasts.push(input),
    attach: () => true,
  });
  expect(model.labels()).toEqual({ fixFinding: "Fix", fixCheck: "Fix in this thread", fixFindings: "Fix findings in this thread" });
  expect(model.ask()).toBe(true);
  expect(toasts[0]).toEqual({ type: "success", title: "Added to the composer", description: "The pull request is in the composer. Type your question, then send." });
  expect(model.explain()).toBe(true);
  expect(toasts[1]!.description).toBe("The question is in the composer. Read it over, then send.");
  expect(await model.fix(null)).toBe(true);
  expect(toasts[2]!.description).toBe("The task is in the composer. Read it over, then send.");
  expect(threads).toBe(0);
  expect(checkouts).toBe(0);
  expect(drafts.length).toBe(3);
});

test("without a composer the labels stay 'in a thread'", () => {
  const model = createPullRequestHandoffModel({ subject: () => subject, newThread: () => null, setDraft: () => {}, checkout: async () => false, toast: () => {} });
  expect(model.labels().fixFindings).toBe("Fix findings in a thread");
});
