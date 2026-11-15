// The sidebar art follows the theme that is showing, with no rebuild (SidebarStageBackdrop.tsx): the
// reference's inline SVG is coloured by its theme's custom properties, so a theme change repaints it.
import { expect, open, test } from "nsh/test";

const options = { width: 320, height: 300, platform: "macos" as const };
const line = (texts: string[], prefix: string) => texts.find((text) => text.startsWith(prefix)) ?? "";

test("every theme with art has its own four files, and a custom theme has none", async () => {
  const app = await open("./StageBackdropFixture.tsx", options);
  await expect(line(app.texts(), "themes:")).toBe("themes:default,t3-chat,grove,ocean,ember,iris files:24");
  await expect(line(app.texts(), "custom:")).toBe("custom:null");
});

test("the art swaps the moment a theme is applied live", async () => {
  const app = await open("./StageBackdropFixture.tsx", options);
  // The default build is Ocean; the fixture's window is one scheme throughout.
  const scheme = line(app.texts(), "dev:").split("/")[1]!;
  await expect(line(app.texts(), "dev:")).toBe(`dev:ocean/${scheme}`);
  await expect(line(app.texts(), "nightly:")).toBe(`nightly:ocean/${scheme}`);
  await app.press("label:Apply ember");
  await app.waitFor(`text:dev:ember/${scheme}`);
  await app.waitFor(`text:nightly:ember/${scheme}`);
  // A different theme per appearance: the scheme showing picks its own theme's file.
  await app.press("label:Apply split");
  await app.waitFor(`text:dev:${scheme === "dark" ? "iris" : "grove"}/${scheme}`);
  await expect(app.count("label:Sidebar backdrop")).toBe(1);
});

test("a theme with no art of its own keeps the build's default file", async () => {
  const app = await open("./StageBackdropFixture.tsx", options);
  await app.press("label:Apply ember");
  await app.waitFor("text:Apply ember");
  await app.press("label:Apply custom");
  await app.waitFor("text:dev:build");
  await app.waitFor("text:nightly:build");
});
