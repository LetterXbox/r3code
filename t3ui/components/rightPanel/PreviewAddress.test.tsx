import { expect, open, test } from "nsh/test";

const size = { width: 1300, height: 800, platform: "macos" as const };

test("the address field reveals Open in system browser on hover and hides it while editing", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Browser");
  await app.waitFor("text:No preview yet");
  await app.type("label:Search or enter URL", "localhost:3000");
  await app.keyboard.press("enter");
  await app.waitFor("label:Select localhost:3000");
  // Shown only while the pointer is over the field and the field is not focused.
  await app.hover("id:Preview address field");
  await app.waitUntil(() => app.shows("label:Open in system browser"));
});
