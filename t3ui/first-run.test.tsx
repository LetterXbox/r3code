// First run in the full app, on server-shaped data (FirstRunSeed pushes a config snapshot, a shell snapshot and the lifecycle welcome
// through the store's real ingestion hooks): a brand-new workspace opens the Welcome page, a used one opens the app.
import { expect, open, test } from "nsh/test";

test("a brand-new workspace opens the Welcome page with its agents instead of the shell", async () => {
  const app = await open("./FirstRunFixture.tsx", { storage: { firstRunScenario: "ready" }, width: 1280, height: 800 });
  await app.waitFor("text:Welcome to R3 Code");
  await expect(app.texts()).toContain("Setting up legion.");
  await expect(app.texts()).toContain("Agents");
  await expect(app.shows("label:Agent Claude")).toBe(true);
  await expect(app.texts()).toContain("Ready");
  await expect(app.shows("label:Sign in: Codex")).toBe(false);
  await expect(app.shows("label:Set up: Codex")).toBe(true);
  await expect(app.texts()).toContain("Add more agents");
  await expect(app.texts()).toContain("R3 Code collects anonymous usage data to improve the app. To opt out, see the privacy policy.");
});

test("Turn on lives in the add-more grid, which Add more agents opens", async () => {
  const app = await open("./FirstRunFixture.tsx", { storage: { firstRunScenario: "ready" }, width: 1280, height: 800 });
  await app.waitFor("text:Welcome to R3 Code");
  await expect(app.shows("label:Agent OpenCode")).toBe(false);
  await app.press("label:Add more agents");
  await app.waitFor("label:Agent OpenCode");
  await expect(app.shows("label:Turn on: OpenCode")).toBe(true);
});

test("with a ready agent, Start finishes setup and shows the app", async () => {
  const app = await open("./FirstRunFixture.tsx", { storage: { firstRunScenario: "ready" }, width: 1280, height: 800 });
  await app.waitFor("text:Welcome to R3 Code");
  await expect(app.shows("label:Start without an agent")).toBe(false);
  await app.press("label:Start");
  await app.waitUntil(() => !app.texts().includes("Welcome to R3 Code"));
  await expect(app.shows("label:New thread")).toBe(true);
});

test("without any agent the page asks for one and offers Start without an agent", async () => {
  const app = await open("./FirstRunFixture.tsx", { storage: { firstRunScenario: "noAgent" }, width: 1280, height: 800 });
  await app.waitFor("text:Welcome to R3 Code");
  await expect(app.texts()).toContain("Set up one agent to start.");
  await expect(app.shows("label:Start without an agent")).toBe(true);
  await expect(app.shows("label:Install: Claude")).toBe(true);
  await expect(app.shows("label:Set up: Codex")).toBe(true);
  await app.press("label:Start without an agent");
  await app.waitUntil(() => !app.texts().includes("Welcome to R3 Code"));
});

test("a workspace that already has work opens the app, with no Welcome page", async () => {
  const app = await open("./FirstRunFixture.tsx", { storage: { firstRunScenario: "used" }, width: 1280, height: 800 });
  await app.waitFor("label:New thread");
  await expect(app.texts()).not.toContain("Welcome to R3 Code");
});

test("the projects found in agent history are offered, the recent ones picked, and Start imports them", async () => {
  const app = await open("./FirstRunFixture.tsx", { storage: { firstRunScenario: "import" }, width: 1280, height: 800 });
  await app.waitFor("text:Projects");
  await app.waitFor("text:Import 2 projects and their threads");
  await expect(app.texts()).toContain("From your Claude Code, Codex, and Pi history");
  await expect(app.texts()).toContain("Import 2 projects and start");
  await app.press("label:Review all 3");
  await app.waitFor("text:2 of 3 selected");
  // A folder without a repository sits under "Other folders", collapsed as in the reference (WelcomePage.tsx OtherFolders).
  await app.press("label:Other folders");
  await app.waitFor("label:Import /work/notes");
  await app.press("label:Import /work/notes");
  await app.waitFor("text:3 of 3 selected");
  await app.press("label:Select none");
  await app.waitFor("text:0 of 3 selected");
  await expect(app.texts()).toContain("Start");
  await app.press("label:Select all");
  await app.press("label:Start");
  await app.waitFor("text:Imported 12 threads");
});

test("Install on an agent opens the setup terminal with its command to review, and Close removes it", async () => {
  const app = await open("./FirstRunFixture.tsx", { storage: { firstRunScenario: "noAgent" }, width: 1280, height: 800 });
  await app.waitFor("label:Install: Claude");
  await app.press("label:Install: Claude");
  await app.waitFor("label:Agent setup terminal");
  await expect(app.texts()).toContain("Review the command, then press Enter to run it.");
  await app.press("label:Close setup terminal");
  await app.waitUntil(() => !app.shows("label:Agent setup terminal"));
});

test("Set up on Codex opens its welcome card with the ChatGPT and CLI choices, and closes it again", async () => {
  const app = await open("./FirstRunFixture.tsx", { storage: { firstRunScenario: "ready" }, width: 1280, height: 800 });
  await app.waitFor("text:Welcome to R3 Code");
  await app.press("label:Set up: Codex");
  await app.waitFor("id:Codex welcome card");
  await expect(app.texts()).toContain("Continue with ChatGPT");
  await expect(app.texts()).toContain("Use existing CLI");
  await app.press("label:Set up: Codex");
  await app.waitUntil(() => !app.shows("id:Codex welcome card"));
});
