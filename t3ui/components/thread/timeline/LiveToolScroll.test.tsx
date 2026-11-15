import { expect, open, test } from "nsh/test";
test("expanded live tools stay in a bounded view with their own scroll", async () => {
  const app = await open("./LiveToolScrollFixture.tsx", { width: 900, height: 700 });
  await expect(app.shows("text:After the capped tool list")).toBe(true);
  await expect(app.shows("label:Tool calls")).toBe(true);
  await app.scroll("label:Tool calls", 4000);
  await expect(app.shows("text:After the capped tool list")).toBe(true);
});
