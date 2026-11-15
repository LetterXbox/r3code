// Add project with several environments: the chooser, the environment every call goes to, the publish host dropdown, and the app-access suggestion after a clone.
import { expect, open, test } from "nsh/test";

const FIELD = "label:Search commands, projects, and threads";
const called = (app: Awaited<ReturnType<typeof open>>, prefix: string) => app.texts().some((text) => text.startsWith(`call ${prefix}`));

async function chooser() {
  const app = await open("./AddProjectEnvironmentsFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Open add project");
  await app.waitFor("text:Environments");
  return app;
}

test("with several environments Add project starts on an Environments list", async () => {
  const app = await chooser();
  await expect(app.texts()).toContain("Studio");
  await expect(app.texts()).toContain("Laptop");
  await expect(app.texts()).not.toContain("Sources");
});

test("choosing an environment continues to its sources and sends every call there; Back returns to the chooser", async () => {
  const app = await chooser();
  await app.press("text:Laptop");
  await app.waitFor("text:Sources");
  await app.waitUntil(() => called(app, "server.discoverSourceControl env=saved:laptop"));
  await expect(called(app, "server.getConfig env=saved:laptop")).toBe(true);
  await app.press("label:Back");
  await app.waitFor("text:Environments");
});

test("a project added to another environment is created there and no thread is opened here", async () => {
  const app = await chooser();
  await app.press("text:Studio");
  await app.waitFor("text:Local folder");
  await app.press("text:Local folder");
  await app.waitFor("text:code");
  await app.submit(FIELD);
  await app.waitUntil(() => called(app, "projects.mutate env=saved:studio"));
  await app.waitFor("text:Added me");
});

test("New project names the environment it creates on", async () => {
  const app = await chooser();
  await app.press("text:Studio");
  await app.waitFor("text:New project");
  await app.press("text:New project");
  await app.type(FIELD, "my-app");
  await expect(app.texts()).toContain("Creates /home/u/projects/my-app on Studio");
});

test("the publish host is a dropdown, not a press-to-cycle", async () => {
  const app = await chooser();
  await app.press("text:Studio");
  await app.waitFor("text:New project");
  await app.press("text:New project");
  await app.type(FIELD, "my-app");
  await app.waitFor("label:Host for the new repository");
  await expect(app.texts()).toContain("GitHub");
  await app.press("label:Host for the new repository");
  await app.waitFor("text:GitLab");
  await expect(app.texts()).toContain("octo/my-app");
  await app.press("label:GitLab");
  await app.waitFor("text:octo-lab/my-app");
  await expect(app.texts()).not.toContain("octo/my-app");
});

test("a cloned GitHub repository the app does not reach raises the install suggestion toast", async () => {
  const app = await chooser();
  await app.press("text:Studio");
  await app.waitFor("text:Git URL");
  await app.press("text:Git URL");
  await app.type(FIELD, "https://github.com/octo/repo.git");
  await app.submit(FIELD);
  await app.submit(FIELD);
  await app.waitFor("text:Give T3 Code for GitHub access to octo");
  await expect(called(app, "sourceControl.appAccess env=")).toBe(true);
  await expect(app.shows("label:Install")).toBe(true);
});
