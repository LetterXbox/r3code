import { expect, test } from "nsh/test";
import { createSshPasswordPrompts, destinationFromPrompt, EXPIRED_MESSAGE, formatRemainingSeconds, type PromptFs } from "./sshPasswordPrompts";

function memory() {
  const files = new Map<string, string>();
  const fs: PromptFs = {
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => { const t = files.get(p); if (t === undefined) throw new Error("ENOENT"); return t; },
    write: async (p, t) => { files.set(p, t); },
    remove: async (p) => { files.delete(p); },
    exists: async (p) => files.has(p),
  };
  return { fs, files };
}

test("a prompt file becomes the dialog's request and Continue writes the answer", async () => {
  const m = memory();
  let clock = 1000;
  const prompts = createSshPasswordPrompts({ dir: "/a", fs: m.fs, now: () => clock });
  prompts.begin("box", "me");
  m.files.set("/a/p1.prompt", "me@box's password: ");
  await prompts.poll();
  expect(prompts.queue()).toEqual([{ requestId: "p1", destination: "box", username: "me", prompt: "me@box's password:", expiresAt: 1000 + 180_000 }]);
  await prompts.resolve("p1", "hunter2");
  expect(m.files.get("/a/p1.answer")).toBe("hunter2");
  expect(prompts.queue()).toEqual([]);
});

test("the remembered password answers the next attempt once, a wrong one asks again", async () => {
  const m = memory();
  const prompts = createSshPasswordPrompts({ dir: "/a", fs: m.fs, now: () => 0 });
  prompts.begin("box", null);
  m.files.set("/a/p1.prompt", "box's password:");
  await prompts.poll();
  await prompts.resolve("p1", "pw");
  prompts.end();
  prompts.begin("box", null);
  m.files.set("/a/p2.prompt", "box's password:");
  await prompts.poll();
  expect(m.files.get("/a/p2.answer")).toBe("pw");
  expect(prompts.queue()).toEqual([]);
  m.files.set("/a/p3.prompt", "box's password:");
  await prompts.poll();
  expect(prompts.queue().map((r) => r.requestId)).toEqual(["p3"]);
});

test("Cancel writes the cancel file; an expired or vanished prompt reports the reference message", async () => {
  const m = memory();
  let clock = 0;
  const prompts = createSshPasswordPrompts({ dir: "/a", fs: m.fs, now: () => clock });
  m.files.set("/a/p1.prompt", "Verification code:");
  await prompts.poll();
  await prompts.resolve("p1", null);
  expect(m.files.has("/a/p1.cancel")).toBe(true);
  m.files.set("/a/p2.prompt", "Verification code:");
  await prompts.poll();
  clock = 200_000;
  await expect(prompts.resolve("p2", "123")).rejects.toThrow(EXPIRED_MESSAGE);
  m.files.delete("/a/p2.prompt");
  clock = 0;
  m.files.set("/a/p3.prompt", "Verification code:");
  await prompts.poll();
  m.files.delete("/a/p3.prompt");
  await expect(prompts.resolve("p3", "1")).rejects.toThrow(EXPIRED_MESSAGE);
});

test("helpers", () => {
  expect(destinationFromPrompt("me@box.local's password:")).toBe("box.local");
  expect(destinationFromPrompt("(me@box) Password:")).toBe(null);
  expect(formatRemainingSeconds(179)).toBe("2:59");
});
