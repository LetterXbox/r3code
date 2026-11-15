import { expect, test } from "nsh/test";
import { parseStack } from "./pullRequestDetail.logic";
import { planStack, stackActionPayload } from "./pullRequestStack.logic";

const stack = parseStack({
  id: "s", number: 1, url: "u", base: "main",
  layers: [
    { number: 1, title: "Base", headBranch: "a", state: "merged", headSha: "s1" },
    { number: 2, title: "Middle", headBranch: "b", state: "open", headSha: "s2" },
    { number: 3, title: "Top", headBranch: "c", state: "open", isDraft: false, headSha: "s3" },
  ],
})!;
const ref = { projectId: "p", repository: "a/b", number: 2 };

test("a merge covers the unmerged layers up to this one, a rebase every unmerged layer", () => {
  const plan = planStack(stack, 2);
  expect(plan.position).toBe(2);
  expect(plan.mergeLayers.map((layer) => layer.number)).toEqual([2]);
  expect(plan.unmerged.map((layer) => layer.number)).toEqual([2, 3]);
  expect(plan.mergeDisabled).toBe(false);
  expect(plan.rebaseDisabled).toBe(false);
  expect(stackActionPayload(ref, stack, plan, "merge", "squash")).toEqual({
    ...ref, number: 2, stackNumber: 1, expectedStackHeads: [{ number: 2, headSha: "s2" }], action: "merge", mergeMethod: "squash",
  });
  expect(stackActionPayload(ref, stack, plan, "update-branch", "squash")).toEqual({
    ...ref, number: 3, stackNumber: 1, expectedStackHeads: [{ number: 2, headSha: "s2" }, { number: 3, headSha: "s3" }], action: "update-branch", updateMethod: "rebase",
  });
});

test("a draft layer, a stale read, an unknown head or a pending action holds the stack back", () => {
  expect(planStack({ ...stack, layers: stack.layers.map((layer) => (layer.number === 2 ? { ...layer, isDraft: true } : layer)) }, 2)).toMatchObject({ mergeDisabled: true, mergeBlockedByLayer: true });
  expect(planStack(stack, 2, { stale: true })).toMatchObject({ mergeDisabled: true, rebaseDisabled: true });
  expect(planStack(stack, 2, { pending: true }).mergeDisabled).toBe(true);
  const unknown = { ...stack, layers: stack.layers.map((layer) => (layer.number === 3 ? { ...layer, headSha: "" } : layer)) };
  expect(planStack(unknown, 2).rebaseDisabled).toBe(true);
  expect(planStack(unknown, 3).mergeDisabled).toBe(true);
  expect(stackActionPayload(ref, unknown, planStack(unknown, 3), "merge", "merge")).toBeNull();
  // A merged layer cannot be merged again.
  expect(planStack(stack, 1).mergeDisabled).toBe(true);
});
