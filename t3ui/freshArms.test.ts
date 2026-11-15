import { expect, test } from "nsh/test";
import { disarmFreshContext, freshContextArm, freshContextThreads, setFreshContext } from "./store";

test("a fresh-session arm carries its own time and a send disarms only the arm it read", () => {
  setFreshContext("t1", true);
  const first = freshContextArm("t1")!;
  expect(first).toBeGreaterThan(0);
  expect(freshContextThreads()).toContain("t1");
  // /clear again while the send is in flight: a later arm.
  setFreshContext("t1", true);
  const second = freshContextArm("t1")!;
  expect(second).toBeGreaterThan(first);
  disarmFreshContext("t1", first);
  expect(freshContextArm("t1")).toBe(second);
  disarmFreshContext("t1", second);
  expect(freshContextArm("t1")).toBeUndefined();
  expect(freshContextThreads()).not.toContain("t1");
});
