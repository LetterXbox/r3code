import { expect, test } from "nsh/test";
import { createPermissionPoller, PERMISSION_CHECK_FAILED_MESSAGE } from "./permissionPoller";

test("polls, keeps the last status on failure with the reference copy, and stops", async () => {
  let calls = 0;
  let fail = false;
  const poller = createPermissionPoller(async () => { calls += 1; if (fail) throw new Error("x"); return { mic: true }; }, { mic: false });
  poller.start();
  await poller.refresh();
  expect(poller.snapshot()).toEqual({ status: { mic: true }, error: null });
  fail = true;
  await poller.refresh();
  expect(poller.snapshot()).toEqual({ status: { mic: true }, error: PERMISSION_CHECK_FAILED_MESSAGE });
  poller.stop();
  const before = calls;
  await poller.refresh();
  expect(calls).toBe(before);
});
