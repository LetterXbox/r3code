import { expect, open, test } from "nsh/test";

test("a focused editor gives the keyboard up before it turns read-only, and other fields keep Backspace", async () => {
  const app = await open("./EditorDisableFixture.tsx");
  await app.press("label:Focus editor");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("focused=true")));
  await app.press("label:Disable editor");
  // The read-only flip lands only after the blur was reported.
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("focused=false disabled=true")));
  await app.type("label:Plain field", "d");
  await app.waitUntil(() => app.texts().some((text) => text.endsWith("field=abcd")));
  await app.keyboard.press("backspace");
  await app.waitUntil(() => app.texts().some((text) => text.endsWith("field=abc")));
  await expect(app.texts().some((text) => text.includes("disabled=true"))).toBe(true);
});
