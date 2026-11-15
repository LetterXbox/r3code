import { expect, open, test } from "nsh/test";
import { parseAcknowledged, sharingProfiles } from "./ChatGptWelcome";

test("a ChatGPT profile that shares its plan gets the connected dialog once, and Continue acknowledges it", async () => {
  const app = await open("./ChatGptWelcomeFixture.tsx", { width: 900, height: 700 });
  await expect(app.texts()).toContain("Your ChatGPT plan is connected");
  await expect(app.texts()).toContain("Codex on Studio Mac");
  await app.press("label:Continue");
  await expect(app.texts()).not.toContain("Your ChatGPT plan is connected");
});

test("only authenticated sharing providers count, keyed per environment, instance and profile", () => {
  const auth = (status: string, sharing: boolean) => ({ status, type: null, label: null, email: "a@b.c", canLogout: null, action: null, subscriptionSharing: sharing });
  const profiles = sharingProfiles("env", "Mac", [
    { instanceId: "codex", displayName: null, auth: auth("authenticated", true) },
    { instanceId: "other", displayName: "X", auth: auth("authenticated", false) },
    { instanceId: "off", displayName: "Y", auth: auth("unauthenticated", true) },
  ] as never);
  expect(profiles).toEqual([{ key: JSON.stringify(["env", "codex", "a@b.c"]), environmentLabel: "Mac", providerName: "Codex" }]);
  expect(parseAcknowledged("not json")).toEqual([]);
  expect(parseAcknowledged('["a", 1]')).toEqual(["a"]);
});
