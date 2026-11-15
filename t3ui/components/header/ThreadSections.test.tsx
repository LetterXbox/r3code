import { expect, open, test } from "nsh/test";

const size = { width: 900, height: 900, platform: "macos" } as const;

test("a plain press on a server opens it in the browser panel, not the system browser", async () => {
  const app = await open("./ThreadSectionsFixture.tsx", size);
  await app.waitFor("label:localhost:3000");
  await app.press("label:localhost:3000");
  await expect(app.texts().join("|")).toContain("preview:http://localhost:3000");
  await expect(app.texts().join("|")).not.toContain("external:");
});

test("an automation row has Edit, Run now, a Pause switch and a Manage header action", async () => {
  const app = await open("./ThreadSectionsFixture.tsx", size);
  await app.waitFor("label:Edit Nightly sweep");
  await expect(app.shows("label:Run Nightly sweep now")).toBe(true);
  await expect(app.shows("label:Pause Nightly sweep")).toBe(true);
  await app.press("label:Manage scheduled tasks");
  await expect(app.texts().join("|")).toContain("tasks:all");
  await app.press("label:Edit Nightly sweep");
  await expect(app.texts().join("|")).toContain("tasks:daily");
});

test("a webhook task has no Run now, and a running task cannot be run again", async () => {
  const app = await open("./ThreadSectionsFixture.tsx", size);
  await app.waitFor("label:Edit On push");
  await expect(app.shows("label:Run On push now")).toBe(false);
  await expect(app.shows("label:Edit On push")).toBe(true);
  await expect(app.enabled("label:Run Running now now")).toBe(false);
});

test("a failed pause says Could not update automation with the server's reason", async () => {
  const app = await open("./ThreadSectionsFixture.tsx", size);
  await app.waitFor("label:Pause Nightly sweep");
  await app.press("label:Pause Nightly sweep");
  await app.waitFor("text:Could not update automation");
  await expect(app.shows("text:server said no")).toBe(true);
});

test("Run now sends the task's id", async () => {
  const app = await open("./ThreadSectionsFixture.tsx", size);
  await app.waitFor("label:Run Nightly sweep now");
  await app.press("label:Run Nightly sweep now");
  await app.wait(100);
  await expect(app.texts().join("|")).toContain('request:scheduledTasks.runNow:{"id":"daily"}');
});
