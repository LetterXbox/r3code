// AlertDialog focus: Cancel takes the focus on open and Enter activates the focused button (ConfirmDialogHost).
import { expect, open, test } from "nsh/test";

const logged = (app: Awaited<ReturnType<typeof open>>, line: string) => app.texts().includes(`log ${line}`);

test("Enter on open answers Cancel; Tab to Confirm then Enter confirms", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Ask");
  await app.waitFor("label:Cancel");
  await app.wait(50);
  await app.keyboard.press("enter");
  await app.waitUntil(() => logged(app, "confirmed false"));
  await app.press("label:Ask");
  await app.waitFor("label:Cancel");
  await app.wait(50);
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitUntil(() => logged(app, "confirmed true"));
  await expect(logged(app, "confirmed true")).toBe(true);
});
