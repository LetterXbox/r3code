import { expect, test } from "nsh/test";
import { createPullRequestThreadLinksModel } from "./pullRequestThreadLinksModel";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(request: (method: string, payload: unknown) => Promise<unknown>, url = "https://github.com/o/r/pull/7") {
  const toasts: { title: string; description: string }[] = [];
  const model = createPullRequestThreadLinksModel({
    request,
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    target: () => ({ host: "github.com", repository: "o/r", number: 7, url }),
    supported: () => true,
    toast: (input) => toasts.push({ title: input.title, description: input.description }),
  });
  return { model, toasts };
}

test("archived linked threads still count, as in the reference", async () => {
  const { model } = harness(async () => ({ threads: [
    { id: "a", projectId: "p", title: "One", archivedAt: null },
    { id: "b", projectId: "p", title: "Two", archivedAt: "2026-01-01T00:00:00Z" },
  ] }));
  for (let i = 0; i < 50 && model.linked() === null; i++) await wait(10);
  expect(model.count()).toBe(2);
});

test("a refused link or unlink names the host's word for a change request", async () => {
  const github = harness(async (method) => { if (method === "orchestration.dispatchCommand") throw new Error("busy"); return { threads: [] }; });
  expect(await github.model.changeLink("t1", false)).toBe(false);
  expect(await github.model.changeLink("t1", true)).toBe(false);
  expect(github.toasts.map((toast) => toast.title)).toEqual(["Could not link the pull request", "Could not unlink the pull request"]);
  const gitlab = harness(async (method) => { if (method === "orchestration.dispatchCommand") throw new Error("busy"); return { threads: [] }; }, "https://gitlab.com/g/p/-/merge_requests/7");
  await gitlab.model.changeLink("t1", false);
  expect(gitlab.toasts[0]?.title).toBe("Could not link the merge request");
});
