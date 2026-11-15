import { expect, test } from "nsh/test";
import { showSnapShotFlash, snapShotFlashAvailable } from "./snapShotFlash";

// No host is attached in this test harness (nsh.json's capabilities.host is irrelevant without one), so
// `host.available()` is false: the capability check, and the call built on it, degrade to a harmless no-op
// instead of throwing — exactly the "say it is unbuilt" state third_party/nsh-host-patches/0023's host will be in
// until that draft patch is applied and built.
test("without a host that understands snapshot.flash, the capability reports false and the call is a silent no-op", async () => {
  expect(await snapShotFlashAvailable()).toBe(false);
  expect(await showSnapShotFlash({ bounds: { x: 0, y: 0, width: 100, height: 100 }, animated: true })).toBe(false);
});
