import { expect, open, test } from "nsh/test";

test("a pending request asks for the secret, opens its link, and saves it through secrets.answerRequest", async () => {
  const app = await open("./SecretRequestFixture.tsx", { width: 600, height: 500 });
  await expect(app.texts()).toContain("GitHub token");
  await expect(app.texts()).toContain("Stored securely, never shown to the agent");
  await expect(app.shows("label:Open github.com")).toBe(true);
  await expect(app.shows("label:Save securely")).toBe(true);
  await app.type("label:GitHub token", "ghp_abc");
  await app.press("label:Save securely");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("sent: secrets.answerRequest")));
  const sent = app.texts().find((text) => text.startsWith("sent: "))!;
  expect(sent).toContain('"turnItemId":"item-secret"');
  expect(sent).toContain('"threadId":"thread-1"');
  expect(sent).toContain('"answer":{"type":"save","secret":"ghp_abc"}');
});

test("Decline sends the decline answer; a failure shows generic copy that never carries the value", async () => {
  const app = await open("./SecretRequestFixture.tsx", { width: 600, height: 500 });
  await app.press("label:Fail sends");
  await app.press("label:Decline");
  await app.waitFor("text:Could not answer the request. Try again.");
  await expect(app.texts().some((text) => text.includes("hunter2"))).toBe(false);
  await expect(app.texts().some((text) => text.includes('"answer":{"type":"decline"}'))).toBe(true);
});

test("an answered request is one line: saved or declined", async () => {
  const app = await open("./SecretRequestFixture.tsx", { width: 600, height: 500 });
  await app.press("label:Mark saved");
  await app.waitFor("text:GitHub token · Saved securely and kept private");
  await expect(app.shows("label:Save securely")).toBe(false);
  await app.press("label:Mark declined");
  await app.waitFor("text:GitHub token · Declined");
});

test("a pending request inherited from another thread is a lock row waiting for the original thread", async () => {
  const app = await open("./SecretRequestFixture.tsx", { width: 700, height: 500 });
  await app.press("label:Mark inherited");
  await expect(app.texts()).toContain("GitHub token · Waiting for an answer in the original thread");
  await expect(app.shows("label:Save securely")).toBe(false);
});

test("with a 1Password source the field takes a reference, rejects a bad one and sends a reference answer", async () => {
  const app = await open("./SecretRequestFixture.tsx", { width: 700, height: 500 });
  await app.press("label:Use sources");
  await app.press("label:GitHub token source");
  await app.press("label:1Password");
  await app.type("label:GitHub token", "not a reference");
  await app.press("label:Save securely");
  await expect(app.texts()).toContain("Use a 1Password reference like op://vault/item/field.");
  await app.clear("label:GitHub token");
  await app.type("label:GitHub token", "op://Private/GitHub/token");
  await app.press("label:Save securely");
  await app.waitFor('text:sent: secrets.answerRequest {"threadId":"thread-1","turnItemId":"item-secret","answer":{"type":"reference","reference":{"provider":"work","reference":"op://Private/GitHub/token"}}}');
});
