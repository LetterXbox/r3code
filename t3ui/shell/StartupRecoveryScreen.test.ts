import { expect, open, test } from "nsh/test";
import { offerBody, offerHeading } from "./StartupRecoveryScreen";

test("the managed-policy offer blocks startup with its message, Retry, Copy details and Quit", async () => {
  const app = await open("./StartupRecoveryScreenFixture.tsx", { width: 900, height: 700 });
  await app.waitUntil(() => app.texts().includes("Your organization's managed policy stopped R3 Code from starting."));
  await expect(app.texts()).toContain("Send the details below to your IT administrator.");
  await expect(app.texts()).toContain("it is not valid JSON or does not match the policy schema");
  await expect(app.texts()).toContain("retries 0");
  await app.press("label:Retry");
  await app.waitUntil(() => app.texts().includes("retries 1"));
  await expect(app.texts()).toContain("Copy details");
  await expect(app.texts()).toContain("Quit");
});

test("offer copy for the offers this build (no updater) can make", () => {
  expect(offerHeading({ kind: "managed-policy", message: "x" })).toBe("Your organization's managed policy stopped R3 Code from starting.");
  expect(offerBody({ kind: "managed-policy", message: "it broke" })).toBe("Send the details below to your IT administrator.");
  expect(offerHeading({ kind: "reinstall", version: "1.0.0" })).toBe("R3 Code could not start.");
  expect(offerBody({ kind: "reinstall", version: "1.0.0" })).toBe("Version 1.0.0 last started on this computer. Reinstalling it may fix this.");
  expect(offerHeading({ kind: "releases" })).toBe("R3 Code could not start.");
  expect(offerBody({ kind: "releases" })).toBe("Visit the releases page for the latest build.");
});
