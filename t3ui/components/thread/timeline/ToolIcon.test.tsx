import { expect, open, test } from "nsh/test";

test("a tool call that carries a website icon draws it once it has loaded, one without keeps the tool's mark", async () => {
  const app = await open("./ToolIconFixture.tsx", { width: 600, height: 200 });
  await app.waitUntil(() => app.shows("label:Tool icon"));
  await expect(app.shows("label:Tool icon >> nth=1")).toBe(false);
});
