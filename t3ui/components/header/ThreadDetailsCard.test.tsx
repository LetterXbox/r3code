import { expect, open, test } from "nsh/test";

test("the card opens in the preferred editor and lists installed editors", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Open in VS Code");
  await app.press("label:Open in VS Code");
  await app.waitFor("text:changes opened: 0");
  await expect(app.texts().join("|")).toContain('request:shell.openInEditor:{"cwd":"/repo","editor":"vscode"}');
  await app.press("label:Choose editor");
  await app.waitFor("label:Zed");
  await app.press("label:Zed");
  await app.waitFor("label:Open in Zed");
});

test("the quick action runs the stacked action and shows the result", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Commit, push & PR");
  await expect(app.shows("text:+3")).toBe(true);
  await expect(app.shows("text:-1")).toBe(true);
  await app.press("label:Commit, push & PR");
  await app.waitFor("text:Starting source control action...");
  await expect(app.texts().join("|")).toContain("subscribe:git.runStackedAction:commit_push_pr");
  await app.waitFor("label:Pushed to origin");
});

test("the dropdown lists commit, push and create PR", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Git action options");
  await app.press("label:Git action options");
  await app.waitFor("label:Create PR");
  await expect(app.shows("label:Commit")).toBe(true);
  await expect(app.shows("label:Push")).toBe(true);
});

test("the Changes row opens the changes surface", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Changes");
  await app.press("label:Changes");
  await app.waitFor("text:changes opened: 1");
});

test("the dropdown's Commit opens the dialog and sends the message and the unchecked files", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Git action options");
  await app.press("label:Git action options");
  await app.press("label:Commit");
  await app.waitFor("text:Commit changes");
  await expect(app.shows("text:Leave empty to auto-generate")).toBe(true);
  await app.press("label:Edit files");
  await app.press("label:Include src/a.ts");
  await app.type("label:Commit message", "Fix the build");
  await app.press("label:Commit");
  await app.waitFor("text:Pushed to origin");
  await expect(app.texts().join("|")).toContain('subscribe:git.runStackedAction:commit:Fix the build:["src/b.ts"]');
});

test("the dialog's Commit on new branch is refused with no files selected", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Git action options");
  await app.press("label:Git action options");
  await app.press("label:Commit");
  await app.press("label:Edit files");
  await app.press("label:Select all files");
  await expect(app.enabled("label:Commit on new branch")).toBe(false);
  await expect(app.enabled("label:Commit")).toBe(false);
});

test("the Branch row lists branches and checks one out", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Branch feature");
  await app.press("label:Branch feature");
  await app.waitFor("text:main");
  await app.press("text:main");
  await app.wait(100);
  await expect(app.texts().join("|")).toContain('request:vcs.switchRef:{"cwd":"/repo","refName":"main"}');
});

test("the project scripts row runs the primary script and adds one through the dialog", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Run Test");
  await app.press("label:Run Test");
  await expect(app.texts().join("|")).toContain("run-script:test");
  await app.press("label:Script actions");
  await app.press("label:Add project script");
  await app.waitFor("text:Add Action");
  await app.press("label:Save action");
  await app.waitFor("text:Name is required.");
  await app.type("label:Script name", "Lint");
  await app.type("label:Script command", "bun lint");
  await app.press("label:Save action");
  await app.waitFor("text:Add Action", { state: "gone" });
  await expect(app.texts().join("|")).toContain('request:projects.mutate:');
  await expect(app.texts().join("|")).toContain('"id":"lint","name":"Lint","command":"bun lint"');
});

test("the card's context menu chooses what to show, and Reset to default restores it", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Changes");
  await app.rightClick("label:Thread details");
  const labels = (app.menu() ?? []).map((entry) => (entry as { label?: string }).label);
  await expect(labels).toContain("Environment and worktree");
  await expect(labels).toContain("Reset to default");
  await app.chooseMenuItem("Changes");
  await app.waitFor("label:Changes", { state: "gone" });
  await expect(app.shows("label:Git actions")).toBe(true);
  await app.rightClick("label:Thread details");
  await app.chooseMenuItem("Reset to default");
  await app.waitFor("label:Changes");
});

test("with every item hidden the card offers Choose what to show", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  for (const label of ["Environment and worktree", "Open in editor", "Project scripts", "Branch and pull request", "Git actions", "Changes", "Servers", "Automations", "Lineage", "Side chats"]) {
    await app.waitFor("label:Thread details");
    await app.rightClick("label:Thread details");
    await app.chooseMenuItem(label);
  }
  await app.waitFor("label:Choose what to show");
  await app.press("label:Choose what to show");
  await app.chooseMenuItem("Reset to default");
  await app.waitFor("label:Changes");
});

test("the card shows the environment, linked pull requests, servers, automations, lineage and side chats", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Thread details");
  await app.waitFor("label:Run context: OzBook M3, Local checkout");
  await app.waitFor("label:#12: Add thing");
  await expect(app.shows("label:#9")).toBe(false);
  await app.press("label:Show 1 more");
  await app.waitFor("label:#9");
  await app.waitFor("label:localhost:3000");
  await expect(app.shows("label:localhost:9999")).toBe(false);
  await app.waitFor("label:Nightly sweep");
  await app.waitFor("label:Parent work");
  await app.waitFor("label:Quick question");
});

test("a server's stop button asks the server to stop it by pid and port", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Stop localhost:3000");
  await app.press("label:Stop localhost:3000");
  await app.wait(100);
  await expect(app.texts().join("|")).toContain('request:preview.stopLocalServer:{"pid":42,"port":3000}');
});

test("an automation's pause button updates the task", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  // The reference's switch is labelled with the task: "Pause <title>" / "Resume <title>" (ThreadAutomationsPanel.tsx).
  await app.waitFor("label:Pause Nightly sweep");
  await app.press("label:Pause Nightly sweep");
  await app.wait(100);
  await expect(app.texts().join("|")).toContain('request:scheduledTasks.setEnabled:{"id":"task-1","enabled":false}');
});

test("reopening the card keeps the status stream and shows the Git rows at once", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Branch feature");
  await app.press("label:Toggle card");
  await app.waitFor("label:Thread details", { state: "gone" });
  await app.press("label:Toggle card");
  await expect(app.shows("label:Branch feature")).toBe(true);
  await expect(app.shows("label:Changes")).toBe(true);
  await expect(app.texts().join("|").split("subscribe:subscribeVcsStatus").length - 1).toBe(1);
});

// A git project: the same rows in the reference's order, with the section headers between them.
test("a git project lists its rows in the reference's order under labelled sections", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 1200, platform: "macos" });
  await app.waitFor("label:Quick question");
  const shown = app.texts().slice(1);
  const order = ["OzBook M3", "Open in VS Code", "Test", "feature", "#12: Add thing", "Show 1 more", "Commit, push & PR", "Changes", "Uncommitted", "+3", "-1", "Servers", "localhost:3000", "Terminal · vite", "Automations", "Nightly sweep", "Lineage", "Parent work", "Side chats", "Quick question"];
  const positions = order.map((text) => shown.indexOf(text));
  await expect(positions.filter((at) => at < 0)).toEqual([]);
  await expect(positions).toEqual([...positions].sort((a, b) => a - b));
  await expect(app.shows("label:Initialize Git")).toBe(false);
  await expect(app.shows("label:Run context: OzBook M3, Local checkout")).toBe(true);
});

test("wide Changes totals keep both the additions and the deletions visible", async () => {
  const app = await open("./ThreadDetailsWideFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Changes");
  await expect(app.shows("text:+282,452")).toBe(true);
  await expect(app.shows("text:-16,341")).toBe(true);
});

test("the Add Action dialog shows the reference's fields in order and saves every one", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Script actions");
  await app.press("label:Script actions");
  await app.press("label:Add project script");
  await app.waitFor("text:Add Action");
  const order = ["Add Action", "Actions are project-scoped commands you can run from the top bar or keybindings.", "Name", "Keybinding", "Press shortcut", "Press a shortcut. Use Backspace to clear. Shortcuts are environment-wide. Projects using the same action share its shortcut.", "Command", "Preview URL (optional)", "Open this URL in the in-app preview when this action runs.", "Run automatically on worktree creation", "Wait for it to finish before the agent starts", "Run in the thread's worktree when the thread settles", "Stop this action when the thread settles", "Open preview automatically when this action runs"];
  const texts = app.texts();
  let at = -1;
  for (const label of order) {
    const index = texts.findIndex((text, i) => i > at && text === label);
    await expect(index).toBeGreaterThan(at);
    at = index;
  }
  await expect(app.shows("label:Choose icon")).toBe(true);
  await expect(app.shows("label:Cancel")).toBe(true);
  await app.type("label:Script name", "Dev");
  await app.type("label:Script command", "bun dev");
  await app.type("label:Script preview URL", "http://localhost:5173");
  await app.press("label:Run automatically on worktree creation");
  await app.press("label:Wait for it to finish before the agent starts");
  await app.press("label:Open preview automatically when this action runs");
  await app.press("label:Save action");
  await app.waitFor("text:Add Action", { state: "gone" });
  const log = app.texts().join("|");
  await expect(log).toContain('"id":"dev","name":"Dev","command":"bun dev","icon":"play","runOnWorktreeCreate":true,"async":false,"previewUrl":"http://localhost:5173","autoOpenPreview":true');
});

test("Escape closes the Add Action dialog", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Script actions");
  await app.press("label:Script actions");
  await app.press("label:Add project script");
  await app.waitFor("text:Add Action");
  await app.keyboard.press("escape");
  await app.waitFor("text:Add Action", { state: "gone" });
});

test("deleting a project script asks through the shared confirmation, and only Confirm removes it", async () => {
  const app = await open("./ThreadDetailsFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Script actions");
  await app.press("label:Script actions");
  await app.press("label:Edit Test");
  await app.waitFor("text:Edit Action");
  await app.press("label:Delete");
  await app.waitFor("text:Delete action \"Test\"?");
  await expect(app.texts()).toContain("This action cannot be undone.");
  await app.press("label:Cancel >> nth=1");
  await app.wait(100);
  await expect(app.texts().join("|")).not.toContain('"scripts":[]');
  await app.press("label:Delete");
  await app.waitFor("text:Delete action \"Test\"?");
  await app.press("label:Confirm");
  await app.wait(150);
  await expect(app.texts().join("|")).toContain('request:projects.mutate:');
  await expect(app.texts().join("|")).toContain('"scripts":[]');
  await app.waitFor('text:Deleted action "Test"');
});
