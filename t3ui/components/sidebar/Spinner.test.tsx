import { expect, open, test } from "nsh/test";

test("the spinner the provider update pill shows while an update runs renders", async () => {
  const app = await open("./SpinnerFixture.tsx", { width: 220, height: 80, platform: "macos" });
  await expect(app.shows("label:Loading")).toBe(true);
});
