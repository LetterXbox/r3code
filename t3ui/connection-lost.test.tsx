// The connection lifecycle in the full app: a drop is quiet for the grace period, then "<label> is reconnecting"; a failure says offline
// with Reconnect; a restored connection closes the toast.
import { expect, open, test } from "nsh/test";

test("a dropped connection warns after the grace period, turns to offline on failure, and clears when it is back", async () => {
  const app = await open("./ConnectionFixtureLost.tsx", { width: 1280, height: 800 });
  await app.waitFor("label:New thread");
  await expect(app.texts()).not.toContain("legion is reconnecting");
  await app.waitFor("text:legion is reconnecting");
  await expect(app.shows("label:Reconnect")).toBe(false);
  await app.waitFor("text:legion is offline");
  await expect(app.shows("label:Reconnect")).toBe(true);
  // The fixture restores the connection 4.5s after the failure; the default 5s wait starts late and ends right at it.
  await app.waitUntil(() => !app.texts().includes("legion is offline"), { timeout: 8000 });
  await expect(app.shows("label:Reconnect")).toBe(false);
});
