import { expect, open, test } from "nsh/test";

// The right-hand card of the owner's screenshot: environment, Open in, scripts, Initialize Git, then the
// labelled sections. Nothing may look selected, and the parent that no longer exists has no row.
test("a non-repository folder shows the reference card's rows, section headers and order", async () => {
  const app = await open("./ThreadDetailsReferenceFixture.tsx", { width: 900, height: 900, platform: "macos" });
  await app.waitFor("label:Initialize Git");
  await app.waitFor("text:Previous agents");
  const shown = app.texts().slice(1);
  const at = (text: string) => shown.indexOf(text);
  const order = ["OzBook M3", "Open in Cursor", "Add project script", "Initialize Git", "Servers", "localhost:52689", "Agent · node", "Lineage · 1 running", "Fix menus clipped by browser", "4m", "Previous agents", "46"];
  for (const text of order) await expect(at(text)).toBeGreaterThanOrEqual(0);
  const positions = order.map(at);
  await expect(positions).toEqual([...positions].sort((a, b) => a - b));
  await expect(app.shows("label:Run context: OzBook M3, Local checkout")).toBe(true);
  await expect(app.shows("label:Parent thread")).toBe(false);
  await expect(app.shows("label:Branch main")).toBe(false);
  await expect(app.shows("label:Changes")).toBe(false);
  await expect(app.shows("label:Git actions")).toBe(false);
});

test("Previous agents expands to the finished agents, six at a time", async () => {
  const app = await open("./ThreadDetailsReferenceFixture.tsx", { width: 900, height: 2400, platform: "macos" });
  await app.waitFor("label:Previous agents");
  await expect(app.shows("label:Earlier agent 0")).toBe(false);
  await app.press("label:Previous agents");
  await app.waitFor("label:Earlier agent 0");
  await expect(app.shows("label:Earlier agent 5")).toBe(true);
  await expect(app.shows("label:Earlier agent 6")).toBe(false);
  await app.press("label:Show 12 more");
  await app.waitFor("label:Earlier agent 17");
});

test("Initialize Git runs vcs.init and the card then shows the repository's rows", async () => {
  const app = await open("./ThreadDetailsReferenceFixture.tsx", { width: 900, height: 900, platform: "macos" });
  await app.press("label:Initialize Git");
  await app.waitFor("label:Git actions");
  await expect(app.texts().join("|")).toContain('request:vcs.init:{"cwd":"/folder"}');
  await expect(app.shows("label:Initialize Git")).toBe(false);
  await expect(app.shows("label:Changes")).toBe(true);
});

test("the Lineage heading offers Disconnect agent session while a provider session is attached", async () => {
  const app = await open("./ThreadDetailsReferenceFixture.tsx", { width: 900, height: 900, platform: "macos" });
  await app.waitFor("label:More thread actions");
  await app.press("label:More thread actions");
  await app.waitFor("label:Disconnect agent session");
  await app.press("label:Disconnect agent session");
  await app.wait(100);
  await expect(app.texts().join("|")).toContain('"type":"provider-session.detach"');
});
