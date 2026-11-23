import { expect, open, test } from "nsh/test";

test("a pasted PNG reaches the focused composer with its original bytes", async () => {
  const app = await open("./ImagePasteFixture.tsx", { width: 600, height: 400 });
  await app.paste("id:composer-prompt", { files: ["t3ui/components/mcp/logos/claude.png"] });
  await app.waitUntil(() => app.texts().includes("image/png:137,80,78,71"));
  expect(app.texts()).toContain("image/png:137,80,78,71");
});
