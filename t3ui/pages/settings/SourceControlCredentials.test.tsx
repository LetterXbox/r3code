import { expect, open, test } from "nsh/test";

test("a provider with credentials expands to its token form and account choices, and saving a token patches the server", async () => {
  const app = await open("./SourceControlCredentialsFixture.tsx", { width: 1100, height: 2400 });
  await expect(app.texts()).toContain("Authenticated as");
  await expect(app.shows("label:GitHub token")).toBe(false);
  await app.press("label:Toggle GitHub details");
  await expect(app.texts()).toContain("No token saved; the server uses GH_TOKEN or the gh login.");
  await expect(app.texts()).toContain("Choose which gh login each GitHub host uses, or turn a host off.");
  await app.type("label:GitHub token", "ghp_secret");
  await app.press("label:Save GitHub token");
  await expect(app.texts()).toContain('update {"sourceControlHosts":{"github":{"tokens":{"github.com":"ghp_secret"}}}}');
  await expect(app.texts()).toContain("Saved for github.com.");
});

test("turning a host off writes the account choice", async () => {
  const app = await open("./SourceControlCredentialsFixture.tsx", { width: 1100, height: 2400 });
  await app.press("label:Toggle GitHub details");
  await app.press("label:Use GitHub on github.com");
  await expect(app.texts()).toContain('update {"sourceControlHosts":{"github":{"hosts":{"github.com":{"enabled":false}}}}}');
});

test("the writing style select writes the whole style struct, and Custom shows the instructions field", async () => {
  const app = await open("./SourceControlCredentialsFixture.tsx", { width: 1100, height: 2400 });
  await expect(app.texts()).toContain("Commit and pull request writing");
  await expect(app.texts()).not.toContain("Not available yet");
  await expect(app.texts()).toContain("Commit messages and pull request titles and descriptions match each project's history.");
  await expect(app.shows("label:Custom commit and pull request instructions")).toBe(false);
  await app.press("label:Commit and pull request writing = repo_conventions");
  await app.press("label:Custom instructions");
  await expect(app.texts()).toContain('update {"sourceControlWritingStyle":{"mode":"custom","customInstructions":"","followChangeRequestTemplates":true}}');
  await expect(app.shows("label:Custom commit and pull request instructions")).toBe(true);
});

test("Follow pull request templates writes the struct with the switch flipped", async () => {
  const app = await open("./SourceControlCredentialsFixture.tsx", { width: 1100, height: 2400 });
  await app.press("label:Follow pull request templates");
  await expect(app.texts()).toContain('update {"sourceControlWritingStyle":{"mode":"repo_conventions","customInstructions":"","followChangeRequestTemplates":false}}');
});
