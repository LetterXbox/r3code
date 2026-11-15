import { expect, open, test } from "nsh/test";

test("a live tool body follows its growing output while the reader is at its bottom (WorkLogDetails)", async () => {
  const app = await open("./FollowScrollFixture.tsx", { width: 500, height: 400 });
  await expect(app.texts()).toContain("followed no");
  await app.press("label:More output");
  await app.waitFor("text:followed yes");
});

test("an open work group remembers where its own scroll was left (resolveWorkGroupScrollIndex)", async () => {
  const app = await open("./FollowScrollFixture.tsx", { width: 500, height: 500 });
  await app.scroll("text:call 1", 80);
  await app.press("label:Read memory");
  await expect(app.texts()).toContain("remembered yes");
});
