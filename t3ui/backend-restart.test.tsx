import { expect, open, test } from "nsh/test";

test("an unsent draft is restored after the app restarts", async () => {
  const first = await open("./App.tsx", { width: 1280, height: 800, clock: {} });
  await first.press("label:New thread");
  await first.type("id:composer-prompt", "Keep this across a restart");
  await first.wait(300);
  const saved = first.storage();
  const second = await open("./App.tsx", { width: 1280, height: 800, storage: saved });
  await second.wait(100);
  await expect(() => second.spanStyle("id:composer-prompt >> text:Keep this across a restart")).not.toThrow();
});

test("a restored draft comes only from the selected environment", async () => {
  const a = "ws://127.0.0.1:3777/ws";
  const b = "ws://127.0.0.1:4777/ws";
  const draft = (id: string, text: string) => ({
    drafts: { [id]: text },
    threads: [{ id, projectId: "project", title: "New thread", status: "idle", pinned: false, updatedAt: 10 }],
    selectedId: id,
  });
  const app = await open("./App.tsx", {
    width: 1280, height: 800,
    storage: { environmentUrl: a, draftStates: JSON.stringify({ [a]: draft("a", "Draft A"), [b]: draft("b", "Draft B") }) },
  });
  await app.wait(100);
  await expect(() => app.spanStyle("id:composer-prompt >> text:Draft A")).not.toThrow();
  await expect(app.texts()).not.toContain("Draft B");
});
