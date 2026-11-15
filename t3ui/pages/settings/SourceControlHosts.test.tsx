import { expect, open, test } from "nsh/test";
import { readSignInPrompt, readSignInSettings, signInView, signOutPatch } from "./sourceControlSignIn";
import { hostFieldSaved, hostSettingsPatch, readHostSettings, removeAllPatch } from "./sourceControlHosts";
import { itemSummary } from "./SourceControlDiscovery";

test("sign-in state reads the redacted sign-ins and says what the card offers", () => {
  const settings = { sourceControlHosts: { github: { signIns: { "github.com": "redacted", "ghe.example": "" }, tokens: { "github.com": "redacted" } } } };
  expect(readSignInSettings(settings, "github", "github.com")).toEqual({ signIns: { "github.com": "redacted", "ghe.example": "" }, signedIn: true, tokenOverrides: true });
  expect(readSignInSettings({}, "github", "github.com")).toEqual({ signIns: {}, signedIn: false, tokenOverrides: false });
  expect(signInView({ signedIn: true, tokenOverrides: false, account: "octo", state: { status: "idle" } })).toEqual({ subtitle: "Signed in as octo", action: "sign-out", actionLabel: "Sign out" });
  expect(signInView({ signedIn: true, tokenOverrides: true, account: "octo", state: { status: "idle" } }).subtitle).toBe("Signed in, but the token saved below is used while it can be read.");
  expect(signInView({ signedIn: false, tokenOverrides: false, account: null, state: { status: "failed", message: "x" } }).actionLabel).toBe("Try again");
  expect(signInView({ signedIn: false, tokenOverrides: false, account: null, state: { status: "waiting", prompt: { userCode: "A", verificationUri: "u", expiresAt: 1 } } }).action).toBe("cancel");
  expect(signOutPatch("github", { "github.com": "redacted", "ghe.example": "redacted" }, "github.com")).toEqual({ sourceControlHosts: { github: { signIns: { "github.com": "", "ghe.example": "redacted" } } } });
  expect(readSignInPrompt({ userCode: "ABCD-1234", verificationUri: "https://x", expiresAt: 5 })).toEqual({ userCode: "ABCD-1234", verificationUri: "https://x", expiresAt: 5 });
  expect(readSignInPrompt({ userCode: "A" })).toBe(null);
});

test("host settings save one field and Remove clears them all", () => {
  expect(readHostSettings({ sourceControlHosts: { bitbucket: { email: "a@b.c", apiToken: "redacted" } } }, "bitbucket")).toEqual({ email: "a@b.c", apiToken: "redacted" });
  expect(hostFieldSaved("")).toBe(false);
  expect(hostFieldSaved({ source: "op" })).toBe(true);
  expect(hostSettingsPatch("gitcafe", { token: "t" })).toEqual({ sourceControlHosts: { gitcafe: { token: "t" } } });
  expect(removeAllPatch("bitbucket")).toEqual({ sourceControlHosts: { bitbucket: { accessToken: "", email: "", apiToken: "" } } });
});

test("a provider that is not signed in says how to, and one with every host off says so", () => {
  const base = { provider: true, kind: "gitlab", label: "GitLab", status: "available", version: null, installHint: "Install glab.", executable: "glab", implemented: true, appSignIn: false };
  expect(itemSummary({ ...base, auth: { status: "unauthenticated", account: null, detail: null, accounts: [] } })).toBe("GitLab is not authenticated on this server. Sign in or configure credentials using the glab tool on the server host to enable change request features.");
  expect(itemSummary({ ...base, auth: { status: "unauthenticated", account: null, detail: null, accounts: [{ host: "h", account: "a", active: true, authenticated: true }] } })).toBe("Every GitLab host is turned off.");
  expect(itemSummary({ ...base, auth: { status: "unknown", account: null, detail: null, accounts: [] } })).toBe("Could not verify GitLab. Install glab.");
});

test("Source control shows Repositories first, then signs in through the app by device code", async () => {
  const app = await open("./SourceControlHostsFixture.tsx", { width: 1100, height: 3200 });
  await app.wait(120);
  for (const text of ["Repositories", "Automatically pull", "Remove agent credits when merging", "Default merge method", "Version Control", "Source control providers", "Commits & pull requests"]) await expect(app.texts()).toContain(text);
  await app.press("label:Toggle GitHub details");
  await expect(app.texts()).toContain("T3 Code for GitHub");
  await expect(app.texts()).toContain("Or use your own credentials");
  await app.press("label:Sign in with GitHub");
  await app.wait(80);
  await expect(app.texts()).toContain("Approve the app on GitHub to finish signing in.");
  await expect(app.texts()).toContain(`call sourceControl.signInStart {"provider":"github","host":"github.com"}`);
  await expect(app.shows("label:ABCD-1234")).toBe(true);
  await app.press("label:Approve sign-in");
  await app.wait(120);
  await expect(app.texts()).toContain("Signed in as");
  await expect(app.shows("label:Signed-in GitHub account")).toBe(true);
  await expect(app.texts()).toContain("Reaches repositories in accounts and organizations that installed the app.");
});

test("a host without credentials shows its own fields and saves a token", async () => {
  const app = await open("./SourceControlHostsFixture.tsx", { width: 1100, height: 3200 });
  await app.wait(120);
  await app.press("label:Toggle Bitbucket details");
  for (const text of ["Access token", "Atlassian account email", "API token"]) await expect(app.texts()).toContain(text);
  await app.type("label:Access token", "abc123");
  await app.press("label:Save Access token");
  await app.wait(80);
  await expect(app.texts()).toContain(`call server.updateSettings {"patch":{"sourceControlHosts":{"bitbucket":{"accessToken":"abc123"}}}}`);
  await expect(app.shows("label:Remove Bitbucket settings")).toBe(true);
});
