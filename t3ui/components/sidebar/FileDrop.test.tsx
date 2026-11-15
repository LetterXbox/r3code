import { expect, open, test } from "nsh/test";

const options = { width: 300, height: 300, platform: "macos" as const };

test("files dropped on a row open its thread and wait for its composer", async () => {
  const app = await open("./FileDropFixture.tsx", options);
  await app.dropFiles("label:Drop target, Demo", ["file:///tmp/a.png", "file:///tmp/b.txt"]);
  await expect(app.texts()).toContain("Opened: 1");
  await expect(app.texts()).toContain("Waiting files: 2");
});
