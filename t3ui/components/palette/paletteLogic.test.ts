import { expect, test } from "nsh/test";
import {
  buildPaletteGroups, formatRelativeTimeLabel, formatShortcut, itemOffsets, placeholderFor, scrollOffsetToReveal, type PaletteInput,
} from "./paletteLogic";

const NOW = 1_700_000_000_000;
function input(patch: Partial<PaletteInput> = {}): PaletteInput {
  return {
    mode: "root", query: "", connected: true, canPin: true, appearance: "dark", now: NOW,
    currentThreadId: "t1", currentProjectId: "p1", settings: [],
    projects: [{ id: "p1", name: "t3code", path: "/work/t3code" }, { id: "p2", name: "other", path: "/work/other" }],
    threads: [
      { id: "t1", projectId: "p1", title: "Fix the sidebar", status: "idle", updatedAt: NOW - 5 * 60_000 },
      { id: "t2", projectId: "p2", title: "Write docs", status: "idle", updatedAt: NOW - 3 * 3_600_000 },
    ],
    ...patch,
  };
}

test("shortcut labels use macOS modifier order", () => {
  expect(formatShortcut("mod+shift+n")).toBe("⇧⌘N");
  expect(formatShortcut("mod+alt+shift+a")).toBe("⌥⇧⌘A");
  expect(formatShortcut("mod+u")).toBe("⌘U");
});

test("relative time matches the web labels", () => {
  expect(formatRelativeTimeLabel(NOW - 10_000, NOW)).toBe("just now");
  expect(formatRelativeTimeLabel(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  expect(formatRelativeTimeLabel(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  expect(formatRelativeTimeLabel(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
});

test("empty query lists Actions then Recent Threads with subtitles and times", () => {
  const groups = buildPaletteGroups(input());
  expect(groups.map((group) => group.label)).toEqual(["Actions", "Recent Threads"]);
  const actions = groups[0].items;
  expect(actions[0].title).toBe("New thread in ");
  expect(actions[0].titleStrong).toBe("t3code");
  expect(actions[0].shortcut).toBe("⇧⌘N");
  expect(actions.find((item) => item.title === "Open usage")?.shortcut).toBe("⌘U");
  expect(actions.find((item) => item.title === "New thread in...")?.submenu).toBe(true);
  expect(actions.some((item) => item.title === "Pin project")).toBe(true);
  const thread = groups[1].items[0];
  expect(thread.description).toBe("t3code · Current thread");
  expect(thread.trailing).toBe("5m ago");
});

test("a query searches actions, nested options, threads and projects", () => {
  const groups = buildPaletteGroups(input({ query: "dark" }));
  const nested = groups.find((group) => group.value === "nested-search");
  expect(nested?.items.map((item) => item.title)).toEqual(["Change appearance: Dark"]);
  const docs = buildPaletteGroups(input({ query: "doc" }));
  expect(docs.find((group) => group.value === "threads-search")?.items[0].title).toBe("Write docs");
  const projects = buildPaletteGroups(input({ query: "other" }));
  expect(projects.find((group) => group.value === "projects-search")?.items[0].description).toBe("/work/other");
  expect(projects.some((group) => group.label === "Recent Threads")).toBe(false);
});

test("submenus list their own options and mark the current one", () => {
  const appearance = buildPaletteGroups(input({ mode: "appearance" }));
  expect(appearance[0].items.map((item) => item.title)).toEqual(["System", "Light", "Dark"]);
  expect(appearance[0].items[2].trailing).toBe("Current");
  const projects = buildPaletteGroups(input({ mode: "new-thread-in" }));
  expect(projects[0].label).toBe("Projects");
  expect(projects[0].items.map((item) => item.title)).toEqual(["t3code", "No project", "other"]);
  expect(projects[0].items[0].trailing).toBe("Current");
});

test("the projectless option follows pinned projects and the first unpinned project", () => {
  const projects = buildPaletteGroups(input({ mode: "new-thread-in", projects: [
    { id: "p1", name: "current" }, { id: "p2", name: "pinned", pinned: true },
    { id: "p3", name: "other" }, { id: "p4", name: "last" },
  ] }));
  expect(projects[0].items.map((item) => item.title)).toEqual(["current", "pinned", "No project", "other", "last"]);
});

test("with no projects the project actions drop out and pin needs server support", () => {
  const groups = buildPaletteGroups(input({ projects: [], currentProjectId: null, canPin: false }));
  const titles = groups[0].items.map((item) => item.title);
  expect(titles).not.toContain("New thread in...");
  expect(titles).not.toContain("Project settings");
  expect(titles).toContain("New thread without a project");
  const noPin = buildPaletteGroups(input({ canPin: false }));
  expect(noPin[0].items.some((item) => item.title === "Pin project")).toBe(false);
});

test("scrolling reveals the active row at either edge", () => {
  const groups = buildPaletteGroups(input());
  const offsets = itemOffsets(groups);
  expect(offsets[0].top).toBe(8 + 28);
  expect(scrollOffsetToReveal(offsets[0], 0, 320)).toBe(null);
  const last = offsets[offsets.length - 1];
  const reveal = scrollOffsetToReveal(last, 0, 320);
  expect(reveal !== null && reveal > 0).toBe(true);
  expect(scrollOffsetToReveal(offsets[0], 200, 320)).toBe(offsets[0].top - 8);
});

test("Change theme lists the theme cards with swatches and the current marker", () => {
  const themes = [
    { id: "default", label: "R3 Code", previews: [
      { mode: "light" as const, colors: { canvas: "#fff", accent: "#00f", messageAction: "#00f" } },
      { mode: "dark" as const, colors: { canvas: "#000", accent: "#33f", messageAction: "#33f" } },
    ] },
    { id: "night", label: "Night", previews: [{ mode: "dark" as const, colors: { canvas: "#111", accent: "#f0f", messageAction: "#f0f" } }] },
  ];
  const root = buildPaletteGroups(input({ themes, currentThemeId: "default" }));
  expect(root[0].items.some((item) => item.title === "Change theme" && item.submenu)).toBe(true);
  const groups = buildPaletteGroups(input({ mode: "theme", themes, currentThemeId: "default" }));
  expect(groups[0].label).toBe("Change theme");
  expect(groups[0].items.map((item) => item.title)).toEqual(["R3 Code", "Night"]);
  expect(groups[0].items[0].trailing).toBe("Current");
  expect(groups[0].items[0].swatches?.length).toBe(2);
  expect(groups[0].items[1].description).toBe("For dark mode");
  expect(groups[0].items[1].action).toEqual({ kind: "theme", id: "night", modes: ["dark"] });
});

test("message search adds an In messages group of threads not already listed, with the snippet", () => {
  const groups = buildPaletteGroups(input({
    query: "docs",
    messageMatches: [
      { threadId: "t1", source: "user", snippet: "Fix the sidebar docs", messageCreatedAt: null },
      { threadId: "t2", source: "assistant", snippet: "  wrote the\n docs page", messageCreatedAt: new Date(NOW - 3_600_000).toISOString() },
    ],
  }));
  const messages = groups.find((group) => group.value === "threads-messages");
  expect(messages?.label).toBe("In messages");
  // t2 matches by title already ("Write docs"), so only t1 (title does not match) appears here.
  expect(groups.find((group) => group.value === "threads-search")?.items.map((item) => item.value)).toContain("thread:t2");
  expect(messages?.items.map((item) => item.value)).toEqual(["thread:t1"]);
  expect(messages?.items[0].description).toBe("Fix the sidebar docs");
});

test("Go to file and Search project contents are always listed (as the web does) and open their own modes", () => {
  const none = buildPaletteGroups(input())[0].items;
  expect(none.some((item) => item.title === "Go to file")).toBe(true);
  expect(none.some((item) => item.title === "Search project contents")).toBe(true);
  const items = buildPaletteGroups(input({ workspace: { cwd: "/work/t3code", name: "t3code" } }))[0].items;
  expect(items.find((item) => item.title === "Go to file")?.shortcut).toBe("⌘P");
  expect(items.find((item) => item.title === "Search project contents")?.shortcut).toBe("⇧⌘F");
  const files = buildPaletteGroups(input({ mode: "files", files: [{ path: "src/a/b.ts" }] }));
  expect(files[0].items[0]).toMatchObject({ title: "b.ts", description: "src/a", action: { kind: "open-file", path: "src/a/b.ts" } });
});

test("Change theme carries theme.select's shortcut, Share with guest sits before Restart agent session", () => {
  const withThemes = input({ themes: [{ id: "ocean", label: "Ocean", previews: [] }], thread: { ...THREAD, canShareWithGuest: true } });
  const items = buildPaletteGroups(withThemes)[0].items;
  expect(items.find((item) => item.title === "Change theme")?.shortcut).toBe("⌥⌘A");
  const titles = items.map((item) => item.title);
  expect(titles.indexOf("Show linked pull requests")).toBeLessThan(titles.indexOf("Share with guest"));
  expect(titles.indexOf("Share with guest")).toBeLessThan(titles.indexOf("Restart agent session"));
  const without = buildPaletteGroups(input({ thread: THREAD }))[0].items.map((item) => item.title);
  expect(without).not.toContain("Share with guest");
});

const THREAD = {
  serverThread: true, canFind: true, promptLink: "https://app.t3.codes/new?prompt=hi", promptLinkWithContext: null,
  canLinkPullRequest: true, linkedPullRequests: 0, reference: { text: "https://app.t3.codes/threads/e/t1", description: "Fix the sidebar", notice: "Thread copied" },
};

test("thread actions follow the web's order after New thread without a project", () => {
  const titles = buildPaletteGroups(input({ thread: THREAD, canTriage: true, canCreateProject: true, workspace: { cwd: "/w", name: "w" } }))[0].items.map((item) => item.title);
  const at = (title: string) => titles.indexOf(title);
  expect(at("New thread without a project")).toBeLessThan(at("Triage an issue"));
  expect(at("Triage an issue")).toBeLessThan(at("Find in current thread"));
  expect(at("Find in current thread")).toBeLessThan(at("Copy prompt link"));
  expect(at("Copy prompt link")).toBeLessThan(at("Copy thread"));
  expect(at("Copy thread")).toBeLessThan(at("Link pull request to thread"));
  expect(at("Link pull request to thread")).toBeLessThan(at("Show linked pull requests"));
  expect(at("Show linked pull requests")).toBeLessThan(at("Restart agent session"));
  expect(at("Restart agent session")).toBeLessThan(at("Go to file"));
  expect(at("Search project contents")).toBeLessThan(at("New project"));
  expect(at("New project")).toBeLessThan(at("Add project"));
  expect(at("Add project")).toBeLessThan(at("Change appearance"));
  expect(at("Change appearance")).toBeLessThan(at("Toggle theme editor"));
  expect(at("Toggle theme editor")).toBeLessThan(at("Open pull requests"));
  expect(at("Open pull requests")).toBeLessThan(at("Use R3 Code in another app (MCP)"));
  expect(at("Use R3 Code in another app (MCP)")).toBeLessThan(at("Open usage"));
  expect(at("Open usage")).toBeLessThan(at("Focus Next Workspace Area"));
  expect(at("Focus Previous Workspace Area")).toBeLessThan(at("Open settings"));
  expect(at("Open settings")).toBeLessThan(at("Pin project"));
  expect(at("Pin project")).toBeLessThan(at("Project settings"));
});

test("thread actions need a server thread and the facts that allow them", () => {
  const none = buildPaletteGroups(input())[0].items.map((item) => item.title);
  for (const title of ["Triage an issue", "Find in current thread", "Copy prompt link", "Copy thread", "Link pull request to thread", "Restart agent session", "New project"]) {
    expect(none.includes(title)).toBe(false);
  }
  const draft = buildPaletteGroups(input({ thread: { ...THREAD, serverThread: false, reference: null, canFind: false } }))[0].items.map((item) => item.title);
  expect(draft.includes("Copy prompt link")).toBe(true);
  expect(draft.includes("Restart agent session")).toBe(false);
  expect(draft.includes("Find in current thread")).toBe(false);
  const items = buildPaletteGroups(input({ thread: THREAD }))[0].items;
  expect(items.find((item) => item.title === "Show linked pull requests")?.disabled).toBe(true);
  expect(items.find((item) => item.title === "Find in current thread")?.action).toEqual({ kind: "command", id: "chat.find" });
  expect(items.find((item) => item.title === "Copy prompt link")?.action).toEqual({ kind: "copy", text: THREAD.promptLink, notice: "Prompt link copied", failureTitle: "Could not copy the prompt link" });
  expect(items.find((item) => item.title === "Restart agent session")?.action).toEqual({ kind: "restart-session", threadId: "t1" });
});

test("badges follow the resolved bindings, so a user override replaces the default", () => {
  const items = buildPaletteGroups(input({ shortcuts: { "usage.open": "⌘⇧U", "chat.newLocal": "⌘L" }, thread: THREAD }))[0].items;
  expect(items.find((item) => item.title === "Open usage")?.shortcut).toBe("⌘⇧U");
  expect(items.find((item) => item.title === "New thread in ")?.shortcut).toBe("⌘L");
  expect(items.find((item) => item.title === "Find in current thread")?.shortcut).toBeUndefined();
});

test("Open pull requests waits for the server config", () => {
  expect(buildPaletteGroups(input({ serverConfigLoaded: false }))[0].items.some((item) => item.title === "Open pull requests")).toBe(false);
});

test("content matches open the file at their line", () => {
  const groups = buildPaletteGroups(input({ mode: "content", workspace: { cwd: "/w", name: "w" }, contentMatches: [{ path: "src/a.ts", lineNumber: 7, lineContent: "x" }] }));
  expect(groups[0].items[0].action).toEqual({ kind: "open-file", path: "src/a.ts", line: 7 });
});

test("New project asks for a name and offers the existing-project door", () => {
  const empty = buildPaletteGroups(input({ mode: "new-project" }))[0].items;
  expect(empty.map((item) => item.title)).toEqual(["Add existing project"]);
  const named = buildPaletteGroups(input({ mode: "new-project", query: "demo" }))[0].items;
  expect(named[0].action).toEqual({ kind: "create-project", name: "demo" });
  expect(placeholderFor("new-project")).toBe("Project name");
});

const PR_URL = "https://github.com/acme/widgets/pull/2288";
const PR_THREADS = [
  { id: "t1", projectId: "p1", title: "Fix the sidebar", status: "idle", updatedAt: NOW, relations: { pullRequests: [{ number: 2288, repository: "acme/widgets", url: PR_URL, snapshot: { title: "Tidy rail" } }] } },
  { id: "t2", projectId: "p2", title: "Write docs", status: "idle", updatedAt: NOW - 1000, relations: { pullRequests: [{ number: 22889, repository: "acme/widgets", url: "https://github.com/acme/widgets/pull/22889" }] } },
  { id: "t3", projectId: "p1", title: "Unrelated", status: "idle", updatedAt: NOW - 2000 },
];
const threadTitles = (query: string) => buildPaletteGroups(input({ query, threads: PR_THREADS })).find((group) => group.value === "threads-search")?.items.map((item) => item.title) ?? [];

test("thread search matches linked pull requests by #N, N, owner/repo#N and the whole URL", () => {
  expect(threadTitles("#2288")).toEqual(["Fix the sidebar", "Write docs"]);
  expect(threadTitles("2288")).toContain("Fix the sidebar");
  expect(threadTitles("PR 2288")).toContain("Fix the sidebar");
  expect(threadTitles("acme/widgets#2288")).toEqual(["Fix the sidebar"]);
  expect(threadTitles(PR_URL)).toEqual(["Fix the sidebar"]);
  // A pasted link may go on past the reference, but never cuts a number short.
  expect(threadTitles(`${PR_URL}/files`)).toEqual(["Fix the sidebar"]);
  expect(threadTitles("https://github.com/acme/widgets/pull/228")).toEqual([]);
  expect(threadTitles("#999")).toEqual([]);
});

test("a pull request page's linked threads are action rows while the field holds its query", () => {
  const linkedThreads = { query: PR_URL, environmentId: "env-1", threads: [{ id: "t2", title: "Write docs", archivedAt: null }, { id: "t9", title: "", archivedAt: "2026-01-01" }] };
  const groups = buildPaletteGroups(input({ query: PR_URL, threads: PR_THREADS, linkedThreads }));
  const rows = groups.find((group) => group.value === "threads-search")!.items;
  expect(rows.map((row) => row.value)).toEqual(["thread:env-1:t2", "thread:env-1:t9"]);
  expect(rows.map((row) => row.title)).toEqual(["Write docs", "Untitled thread"]);
  expect(rows.map((row) => row.description)).toEqual(["Linked thread", "Archived thread"]);
  expect(rows[0]).toMatchObject({ searchTerms: [PR_URL, "Write docs"], action: { kind: "open-thread", id: "t2" } });
  // Once the query changes the rows give way to ordinary thread search.
  const typed = buildPaletteGroups(input({ query: "docs", threads: PR_THREADS, linkedThreads }));
  expect(typed.find((group) => group.value === "threads-search")!.items.map((row) => row.value)).toEqual(["thread:t2"]);
});

test("Copy PR link replaces Copy thread when a pull request link is the target", () => {
  const reference = { text: PR_URL, description: PR_URL, notice: "PR link copied", kind: "pull-request" as const };
  const items = buildPaletteGroups(input({ thread: { ...THREAD, reference } }))[0].items;
  const copy = items.find((item) => item.value === "action:copy-thread-reference")!;
  expect(copy.title).toBe("Copy PR link");
  expect(copy.action).toMatchObject({ kind: "copy", text: PR_URL, notice: "PR link copied", failureTitle: "Failed to copy PR link" });
  expect(items.some((item) => item.title === "Copy thread")).toBe(false);
});

test("a thread row carries its leading status pill", () => {
  const pill = { label: "Working", colorClass: "text-info-foreground", dotClass: "bg-info", pulse: true };
  const groups = buildPaletteGroups(input({ threads: [
    { id: "t1", projectId: "p1", title: "Fix the sidebar", status: "running", updatedAt: NOW - 5 * 60_000, statusPill: pill },
    { id: "t2", projectId: "p2", title: "Write docs", status: "idle", updatedAt: NOW - 3 * 3_600_000, statusPill: null },
  ] }));
  const rows = groups.find((group) => group.label === "Recent Threads")!.items;
  expect(rows[0].leadingStatus).toEqual(pill);
  expect(rows[1].leadingStatus).toBeUndefined();
});
