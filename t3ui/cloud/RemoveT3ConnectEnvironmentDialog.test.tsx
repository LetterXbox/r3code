import { expect, open, test } from "nsh/test";
import { removeT3ConnectRegistrationCopy } from "./RemoveT3ConnectEnvironmentDialog";

test("the second paragraph follows the account's registration", () => {
  expect(removeT3ConnectRegistrationCopy("registered")).toEqual({ before: "It stays on your T3 Connect account and keeps its host space. Deregister it in ", link: "T3 Connect settings", after: " to free it." });
  expect(removeT3ConnectRegistrationCopy("unregistered")).toEqual({ before: "It's no longer on your T3 Connect account.", link: null, after: "" });
  expect(removeT3ConnectRegistrationCopy("unknown")).toEqual({ before: "This doesn't change your T3 Connect account. To deregister it there, use ", link: "T3 Connect settings", after: "." });
});

test("the dialog confirms the removal of a T3 Connect environment from this device", async () => {
  const app = await open("./RemoveT3ConnectFixture.tsx", { width: 900, height: 700 });
  await app.press("label:open-registered");
  await expect(app.texts()).toContain("Remove Studio Mac from this device?");
  await expect(app.texts()).toContain("This forgets its pairing, credentials, and cached threads here.");
  await expect(app.texts()).toContain("It stays on your T3 Connect account and keeps its host space. Deregister it in ");
  await app.press("label:Cancel");
  await app.press("label:open-unregistered");
  await expect(app.texts()).toContain("It's no longer on your T3 Connect account.");
  await app.press("label:Cancel");
  await app.press("label:open-unknown");
  await expect(app.texts()).toContain("This doesn't change your T3 Connect account. To deregister it there, use ");
  await app.press("label:Remove from this device");
  await expect(app.texts()).toContain("removed:saved:1");
});
