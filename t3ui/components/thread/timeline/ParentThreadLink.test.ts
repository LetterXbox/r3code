import { expect, test } from "nsh/test";
import { parentThreadLinkDetail, parentThreadLinkFor } from "./parentThreadLink";
import type { ThreadRelations } from "../../header/threadRelations";

const relations = (over: Partial<ThreadRelations>): ThreadRelations => ({ parentThreadId: null, linkOrigin: null, guestShare: null, ...over });
const titleOf = (id: string) => (id === "p1" ? "Planner" : undefined);

test("a side chat reads Context from, and opens its parent", () => {
  const opened: string[] = [];
  const link = parentThreadLinkFor(relations({ parentThreadId: "p1", lineage: { parentThreadId: "p1", relationshipToParent: "fork", rootThreadId: "p1", sideChat: true } }), titleOf, (id) => opened.push(id));
  expect(link).toMatchObject({ title: "Planner", sideChat: true });
  link?.open?.();
  expect(opened).toEqual(["p1"]);
});

test("a subagent names its parent, and an unknown parent reads Parent thread", () => {
  const known = parentThreadLinkFor(relations({ parentThreadId: "p1", lineage: { parentThreadId: "p1", relationshipToParent: "subagent", rootThreadId: "p1", sideChat: false } }), titleOf, () => {});
  expect(known).toMatchObject({ title: "Planner", sideChat: false });
  const unknown = parentThreadLinkFor(relations({ parentThreadId: "gone", lineage: { parentThreadId: "gone", relationshipToParent: "subagent", rootThreadId: "gone", sideChat: false } }), titleOf, () => {});
  expect(unknown?.title).toBe("Parent thread");
});

test("a delegated thread names the environment it came from; a plain thread and a fork have no divider", () => {
  const delegated = parentThreadLinkFor(relations({ linkOrigin: "Studio Mac", delegatedFrom: { environmentId: "e", threadId: "t", title: "Original" } }), titleOf, () => {});
  expect(delegated && parentThreadLinkDetail(delegated)).toBe("Original on Studio Mac");
  expect(delegated?.open).toBe(undefined);
  expect(parentThreadLinkFor(undefined, titleOf, () => {})).toBe(null);
  expect(parentThreadLinkFor(relations({ lineage: { parentThreadId: "p1", relationshipToParent: "fork", rootThreadId: "p1", sideChat: false } }), titleOf, () => {})).toBe(null);
});
