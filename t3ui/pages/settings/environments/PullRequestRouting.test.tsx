import { expect, open, test } from "nsh/test";
import { pullRequestRoutingConnectionKey, pullRequestRoutingPermissionFor, setPermission, summarizePullRequestRouting } from "./PullRequestRoutingSettings";

const SIZE = { width: 900, height: 700 };

test("keys follow the saved endpoints and the summary groups read-and-act before read", () => {
  const env = { environmentId: "e", urls: ["wss://b.example/ws", "wss://a.example/ws"] };
  expect(pullRequestRoutingConnectionKey(env)).toBe(pullRequestRoutingConnectionKey({ environmentId: "e", urls: ["wss://a.example/ws", "wss://b.example/ws"] }));
  expect(pullRequestRoutingConnectionKey({ environmentId: "e", urls: ["wss://u:p@a.example/ws"] })).toBeNull();
  expect(pullRequestRoutingConnectionKey({ environmentId: "e", urls: [] })).toBeNull();
  const stored = setPermission([], env, "read");
  expect(pullRequestRoutingPermissionFor(env, stored)).toBe("read");
  expect(pullRequestRoutingPermissionFor({ environmentId: "e", urls: ["wss://c.example/ws"] }, stored)).toBe("off");
  expect(setPermission(stored, env, "off")).toEqual([]);
  expect(summarizePullRequestRouting([{ label: "Mac", permission: "read" }, { label: "Box", permission: "read-write" }, { label: "Pi", permission: "off" }])).toBe("Box read and act · Mac read PRs");
  expect(summarizePullRequestRouting([{ label: "Mac", permission: "off" }])).toBeNull();
});

test("the section lists each environment, saves a permission and reports a failed save", async () => {
  const app = await open("./PullRequestRoutingFixture.tsx", SIZE);
  await expect(app.texts()).toContain("Pull request sharing");
  await expect(app.texts()).toContain("Off");
  await app.press("label:Expand Pull request sharing");
  await expect(app.texts()).toContain("Machines you trust here can read PR data through each other's source control access. Enable both machines. Read and act may use broader permissions than the machine that owns them. This applies only to this device.");
  await app.press("label:Build box pull request routing");
  await app.press("text:Read and act");
  await expect(app.texts()).toContain("Build box read and act");
  await expect(app.texts().some((text) => text.includes('"permission":"read-write"'))).toBe(true);
  await app.press("label:Fail writes");
  await app.press("label:This Mac pull request routing");
  await app.press("text:Read PRs");
  await expect(app.texts()).toContain("Could not save pull request routing permission");
});

test("one environment shows nothing", async () => {
  const app = await open("./PullRequestRoutingFixture.tsx", SIZE);
  await app.press("label:One environment");
  await expect(app.texts().includes("Pull request sharing")).toBe(false);
});
