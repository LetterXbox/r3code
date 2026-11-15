import { expect, open, test } from "nsh/test";

test("Continue with no token shows the reference's required-token error", async () => {
  const app = await open("./PairingEmptyFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Continue");
  await app.press("label:Continue");
  await app.waitFor("text:Enter a pairing token to continue.");
  await expect(app.texts()).toContain("Enter a pairing token to continue.");
});
