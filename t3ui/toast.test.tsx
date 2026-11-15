// The shared toast stack and confirmation dialog (components/toast, mounted once by App.tsx through shell/ShellOverlays).
import { expect, open, test } from "nsh/test";

const logged = (app: Awaited<ReturnType<typeof open>>, line: string) => app.texts().includes(`log ${line}`);

test("a toast shows its icon title and description, and its dismiss button removes it", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Info");
  await app.waitFor("text:Heads up");
  await expect(app.texts()).toContain("Something to know");
  await app.press("label:Dismiss notification");
  // The closed toast plays its .5s exit (ui/toast.tsx:628) before it leaves the screen; the live stack is empty at once.
  await expect(app.shows("label:Notification stack")).toBe(false);
  await app.wait(600);
  await expect(app.texts()).not.toContain("Heads up");
});

test("an error toast offers to copy its reason", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Error");
  await app.waitFor("label:Copy error");
  await app.press("label:Copy error");
  await app.waitFor("label:Copied error");
  await expect(app.clipboard()).toBe("Permission denied");
});

test("an action button runs its handler; a toast raised under its id replaces it", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Action");
  await app.waitFor("label:Restart");
  await app.press("label:Action again");
  await app.waitFor("text:Update installed");
  await expect(app.texts()).not.toContain("Update ready");
  await expect(app.count("label:Update installed")).toBe(1);
  await app.press("label:Action");
  await app.waitFor("label:Restart");
  await app.press("label:Restart");
  await app.waitUntil(() => logged(app, "restart"));
  // A press only runs the handler, as Base UI's Toast.Action does: the toast stays until the handler closes it.
  await expect(app.texts()).toContain("Update ready");
});

test("toasts stack newest first and show at most three, the rest peeking behind", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Info");
  await app.press("label:Error");
  await app.press("label:Action");
  await app.waitFor("text:Update ready");
  await expect(app.count("role:alert")).toBe(1);
  await app.hover("label:Notification stack");
  await app.waitUntil(() => app.count("role:alert") === 3);
  await expect(app.count("role:alert")).toBe(3);
});

test("a timed toast closes itself", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Quick");
  await app.waitFor("text:Copied");
  await app.waitUntil(() => !app.texts().includes("Copied"), { timeout: 5000 });
  await expect(app.texts()).not.toContain("Copied");
});

test("a toast (by its rectangle) and the confirmation dialog register with the WebView occlusion registry", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800 });
  await expect(app.texts()).toContain("overlays 0");
  await app.press("label:Info");
  await app.waitFor("text:overlays 1");
  await app.press("label:Dismiss notification");
  await app.waitFor("text:overlays 0");
  await app.press("label:Ask");
  await app.waitFor("text:overlays 1");
  await app.press("label:Cancel");
  await app.waitFor("text:overlays 0");
});

test("confirm resolves true on Confirm, false on Cancel and false on Escape", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Ask");
  await app.waitFor("text:Delete this thread?");
  await expect(app.texts()).toContain("It cannot be undone.");
  await app.press("label:Confirm");
  await app.waitUntil(() => logged(app, "confirmed true"));
  await app.press("label:Ask");
  await app.waitFor("label:Cancel");
  await app.press("label:Cancel");
  await app.waitUntil(() => logged(app, "confirmed false"));
  await app.press("label:Ask");
  await app.waitFor("label:Cancel");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("label:Cancel") === 0);
  await expect(app.count("label:Cancel")).toBe(0);
});

test("confirmations queue: the second shows after the first is answered", async () => {
  const app = await open("./ToastFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Ask twice");
  await app.waitFor("text:First?");
  await expect(app.texts()).not.toContain("Second?");
  await app.press("label:Confirm");
  await app.waitFor("text:Second?");
  await app.press("label:Cancel");
  await app.waitUntil(() => logged(app, "first true") && logged(app, "second false"));
  await expect(logged(app, "second false")).toBe(true);
});
