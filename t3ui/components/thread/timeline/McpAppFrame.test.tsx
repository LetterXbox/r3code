import { expect, open, test } from "nsh/test";

test("an MCP app row names its server, offers full screen once its page URL is minted, and says when it cannot load", async () => {
  const app = await open("./McpAppFixture.tsx", { width: 800, height: 400, platform: "macos" });
  await app.waitFor("label:Open full screen");
  await expect(app.texts()).toContain("weather app");
  await app.waitFor("text:Unable to load the maps app");
});
