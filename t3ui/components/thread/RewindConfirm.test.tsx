import { expect, open, test } from "nsh/test";

test("the confirm uses the web's copy and its three actions", async () => {
  const app = await open("./RewindConfirmFixture.tsx", { width: 800, height: 600 });
  await expect(app.texts()).toContain("Rewind chat to before this message. Your prompt and attachments return to the composer. “Revert files too” also undoes your own edits.");
  await app.press("label:Revert files too");
  await expect(app.texts()).toContain("Result files");
});

test("Revert and keep changes leaves the files alone", async () => {
  const app = await open("./RewindConfirmFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Revert and keep changes");
  await expect(app.texts()).toContain("Result keep");
});

test("Cancel and Escape dismiss without rewinding", async () => {
  const first = await open("./RewindConfirmFixture.tsx", { width: 800, height: 600 });
  await first.press("label:Cancel");
  await expect(first.texts()).toContain("Result cancelled");
  const second = await open("./RewindConfirmFixture.tsx", { width: 800, height: 600 });
  await second.keyboard.press("escape");
  await expect(second.texts()).toContain("Result cancelled");
});
