import { expect, test } from "nsh/test";
import { createNewThreadLinkController, findPromptLinkProjects, findPromptLinkPullRequestThread, resolvePromptLinkModelSelection, type NewThreadLinkDeps } from "./newThreadLink";
import { parseNewThreadLink, type NewThreadLink } from "./promptLinkParse";
import { linkPageView } from "./newThreadLinkPageView";

const parse = (search: string): NewThreadLink => {
  const result = parseNewThreadLink(search);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const identity = (key: string) => ({ canonicalKey: key });

function harness(over: Partial<NewThreadLinkDeps> = {}) {
  const log: string[] = [];
  const toasts: string[] = [];
  const deps: NewThreadLinkDeps = {
    threads: () => [],
    projects: () => [{ id: "p-other", path: "/o", repositoryIdentity: identity("github.com/other/thing") }, { id: "p-repo", path: "/r", repositoryIdentity: identity("github.com/acme/widgets") }],
    providers: () => [{ instanceId: "codex", driver: "codex", enabled: true, available: true, status: "ready", models: [{ slug: "gpt-5", name: "GPT-5", isDefault: true }] }],
    openDraft: (id) => { log.push(`draft:${id}`); return true; },
    openThread: (id) => log.push(`thread:${id}`),
    setModel: (s) => log.push(`model:${s.instanceId}/${s.model}`),
    placePrompt: (p, notes) => log.push(`place:${p.text}|${notes.join(";")}`),
    openScratch: async () => "p-scratch",
    serverPullRequestThread: async () => null,
    cloneFacts: async () => ({ newProjectsRoot: "/roots", destinationRoot: "/base", ghqCloneLayout: false }),
    startClone: async (i) => { log.push(`clone:${i.remoteUrl}->${i.destinationPath}`); },
    directoryPath: (url) => url.split("/").pop()!.replace(/\.git$/, ""),
    destinationPath: (root, dir) => `${root}/${dir}`,
    waitForProject: async () => true,
    suggestAppAccess: () => undefined,
    newId: () => "new-project",
    checkout: async ({ projectId, url }) => { log.push(`checkout:${projectId}:${url}`); return true; },
    setDraft: (t) => log.push(`setDraft:${t}`),
    warnHidden: () => log.push("warn"),
    toast: (t) => { toasts.push(`${t.title}:${t.description}`); },
    ...over,
  };
  return { controller: createNewThreadLinkController(deps), log, toasts };
}

test("a link finds its repository's project case-insensitively, also under GitCafe", () => {
  const projects = [{ id: "a", repositoryIdentity: identity("git.cafe/acme/widgets") }, { id: "b", repositoryIdentity: identity("github.com/Other/x") }, { id: "c" }];
  expect(findPromptLinkProjects(projects, { owner: "ACME", name: "Widgets" }).map((p) => p.id)).toEqual(["a"]);
  expect(findPromptLinkProjects(projects, { owner: "other", name: "x" }).map((p) => p.id)).toEqual(["b"]);
});

test("the newest visible thread of the pull request wins; side chats stay hidden", () => {
  const pr = { owner: "acme", name: "widgets", number: 7 };
  const link = { host: "github.com", repository: "Acme/Widgets", number: 7 };
  const threads = [{ id: "old", updatedAt: 1, pullRequests: [link] }, { id: "new", updatedAt: 3, pullRequests: [link] }, { id: "side", updatedAt: 9, sideChat: true, pullRequests: [link] }, { id: "other", updatedAt: 8, pullRequests: [{ ...link, number: 8 }] }];
  expect(findPromptLinkPullRequestThread(threads, pr)?.id).toBe("new");
});

test("the requested provider and model resolve, with the default standing in for an unknown model", () => {
  const providers = [{ instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, available: true, status: "ready", models: [{ slug: "sonnet", name: "Sonnet", isDefault: true }, { slug: "opus", name: "Opus" }] }];
  expect(resolvePromptLinkModelSelection(providers, { provider: "claude", model: "OPUS" })).toEqual({ selection: { instanceId: "claudeAgent", model: "opus" }, exact: true });
  expect(resolvePromptLinkModelSelection(providers, { provider: "claude", model: "nope" })).toEqual({ selection: { instanceId: "claudeAgent", model: "sonnet" }, exact: false });
  expect(resolvePromptLinkModelSelection(providers, { provider: "codex", model: null })).toBeNull();
});

test("a link with a repository opens a draft in its project, picks the model and places the prompt with notes", async () => {
  const { controller, log } = harness();
  await controller.open(parse("?prompt=hello&repo=acme/widgets&provider=codex&model=nope"));
  expect(log).toEqual(["draft:p-repo", "model:codex/gpt-5", "place:hello|The link asked for nope, which codex does not offer here, so its default model is used."]);
  expect(controller.state()).toBeNull();
});

test("a link without a repository opens a draft in the Scratch project; none to offer is the reference's failure", async () => {
  const ok = harness();
  await ok.controller.open(parse("?prompt=hello"));
  expect(ok.log[0]).toBe("draft:p-scratch");
  const none = harness({ openScratch: async () => null });
  await none.controller.open(parse("?prompt=hello"));
  expect(linkPageView(none.controller.state(), false)).toEqual({ title: "Could not open the link", description: "None of your machines can start a thread without a project right now.", actions: [] });
});

test("a repository nobody has asks to clone it; Clone starts projectClone and opens the draft once the project appears", async () => {
  const { controller, log } = harness({ projects: () => [] });
  await controller.open(parse("?prompt=hello&repo=acme/widgets"));
  const view = linkPageView(controller.state(), false)!;
  expect(view.title).toBe("You don't have acme/widgets");
  expect(view.description).toBe("Clone it to work on it here, or start without a project.");
  expect(view.actions.map((a) => a.label)).toEqual(["Clone acme/widgets", "Use without project"]);
  await controller.cloneRepository({ owner: "acme", name: "widgets" });
  expect(log).toEqual(["clone:https://github.com/acme/widgets.git->/roots/widgets", "draft:new-project", "place:hello|"]);
});

test("a failed clone toasts Clone failed and asks again; no clone root is its own failure; a PR link says to open it again", async () => {
  const failing = harness({ projects: () => [], startClone: async () => { throw new Error("denied"); } });
  await failing.controller.open(parse("?prompt=hello&repo=acme/widgets"));
  await failing.controller.cloneRepository({ owner: "acme", name: "widgets" });
  expect(failing.toasts).toEqual(["Clone failed:denied"]);
  expect(failing.controller.state()?.status).toBe("missing-repository");

  const noRoot = harness({ projects: () => [], cloneFacts: async () => ({ newProjectsRoot: null, destinationRoot: "", ghqCloneLayout: false }) });
  await noRoot.controller.open(parse("?prompt=hello&repo=acme/widgets"));
  await noRoot.controller.cloneRepository({ owner: "acme", name: "widgets" });
  expect(linkPageView(noRoot.controller.state(), false)?.description).toBe("This machine cannot clone from a link. Update T3 Code on it, or clone the repository from the command palette.");

  const pr = harness({ projects: () => [] });
  await pr.controller.open(parse("?pr=acme/widgets%237"));
  await pr.controller.cloneRepository({ owner: "acme", name: "widgets" });
  expect(linkPageView(pr.controller.state(), false)).toEqual({ title: "Cloning acme/widgets", description: "Open this link again when the clone finishes.", actions: [] });
});

test("a pull request link with a project asks before it checks out, then checks out and places the prompt", async () => {
  const { controller, log } = harness();
  await controller.open(parse("?pr=acme/widgets%237&prompt=review"));
  const view = linkPageView(controller.state(), false, controller)!;
  expect(view.title).toBe("Check out acme/widgets#7?");
  expect(view.description).toBe("This puts the pull request's code in a new worktree and runs your project's setup script on it.");
  expect(view.actions.map((a) => a.label)).toEqual(["Check out"]);
  expect(linkPageView(controller.state(), true, controller)!.actions[0]).toMatchObject({ label: "Checking out...", disabled: true });
  await controller.checkout();
  // The hidden-characters warning shows once when the page does (warnAboutHiddenCharacters is a no-op for a clean prompt).
  expect(log).toEqual(["warn", "checkout:p-repo:https://github.com/acme/widgets/pull/7", "setDraft:review"]);
  expect(controller.state()).toBeNull();
});

test("a pull request link opens its linked thread, locally or from the server, and places the prompt there", async () => {
  const link = { host: "github.com", repository: "acme/widgets", number: 7 };
  const local = harness({ threads: () => [{ id: "t-local", updatedAt: 1, pullRequests: [link] }] });
  await local.controller.open(parse("?pr=acme/widgets%237&prompt=hi"));
  expect(local.log).toEqual(["thread:t-local", "place:hi|"]);
  const remote = harness({ serverPullRequestThread: async (ids) => (ids.includes("p-repo") ? "t-server" : null) });
  await remote.controller.open(parse("?pr=acme/widgets%237"));
  expect(remote.log).toEqual(["thread:t-server"]);
});

test("Use without project opens the draft in Scratch with the pull request's URL in the prompt", async () => {
  const { controller, log } = harness({ projects: () => [] });
  await controller.open(parse("?pr=acme/widgets%237&prompt=review"));
  controller.useWithoutProject();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(log).toEqual(["draft:p-scratch", "place:review\n\nhttps://github.com/acme/widgets/pull/7|"]);
});
