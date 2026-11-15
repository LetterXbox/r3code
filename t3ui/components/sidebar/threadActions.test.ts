import { expect, test } from "nsh/test";
import { resolveCustomSnooze } from "./CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets, snoozePresetsFromSetting } from "./snooze";
import { registerCommand } from "../../commands/registry";
import type { Thread } from "../../store";
import { clearToasts, toasts } from "../toast/toastState";
import { threadActionNotice } from "./threadActions";
import { buildBulkMenu, buildThreadMenu, bulkMenuState, runThreadAction, threadMenuState, threadUndo } from "./threadActions";
import type { ThreadMenuState } from "./threadActions";

const presets = resolveSnoozePresets(new Date(2026, 5, 3, 10, 0, 0));
const state: ThreadMenuState = {
  branch: null, hasPath: true, hasProject: true, isPinned: false, isSettled: false, isSnoozed: false,
  canSnoozeNow: true, isRegeneratingTitle: false, isRunning: false,
  supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true },
  snoozePresets: presets,
};
const ids = (items: { id: string }[]) => items.map((item) => item.id);

test("the menu lists the web's items in the web's order", async () => {
  await expect(ids(buildThreadMenu(state))).toEqual([
    "pin", "settle", "snooze", "rename", "regenerate-title", "mark-unread", "copy", "project-settings", "archive", "delete",
  ]);
});

test("labels and toggles match buildThreadActionMenuItems", async () => {
  const menu = buildThreadMenu({ ...state, isPinned: true, isSettled: true, isSnoozed: true, branch: "feat/x", isRegeneratingTitle: true });
  const byId = Object.fromEntries(menu.map((item) => [item.id, item]));
  await expect(byId["unpin"].label).toBe("Unpin thread");
  await expect(byId["unsettle"].label).toBe("Un-settle thread");
  await expect(byId["unsnooze"].label).toBe("Wake thread");
  await expect(byId["new-thread-on-branch"].label).toBe("New thread on feat/x");
  await expect(byId["regenerate-title"].label).toBe("Regenerating…");
  await expect(byId["regenerate-title"].disabled).toBe(true);
  await expect(ids(byId["copy"].children ?? [])).toEqual(["copy-path", "copy-branch", "copy-thread", "copy-thread-id"]);
  await expect(byId["delete"].destructive).toBe(true);
});

test("archive is disabled while running and snooze while a request waits", async () => {
  const menu = buildThreadMenu({ ...state, isRunning: true, canSnoozeNow: false });
  await expect(menu.find((item) => item.id === "archive")?.disabled).toBe(true);
  await expect(menu.find((item) => item.id === "snooze")?.disabled).toBe(true);
});

test("a disconnected environment offers no server actions", async () => {
  const menu = buildThreadMenu({ ...state, supports: { settlement: false, snooze: false, pinning: false, titleRegeneration: false } });
  await expect(ids(menu)).toEqual(["rename", "mark-unread", "copy", "project-settings", "archive", "delete"]);
});

test("snooze presets are In 1 hour, In 3 hours, This evening, Tomorrow, Next week", async () => {
  await expect(presets.map((preset) => preset.label)).toEqual(["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"]);
  const submenu = buildThreadMenu(state).find((item) => item.id === "snooze")?.children ?? [];
  await expect(submenu.length).toBe(6);
  await expect(submenu[0].id).toBe(`snooze:${presets[0].id}`);
  await expect(submenu[5].label).toBe("Custom…");
  await expect(submenu[5].separatorBefore).toBe(true);
});

test("an evening preset that has passed drops out", async () => {
  const late = resolveSnoozePresets(new Date(2026, 5, 3, 19, 0, 0));
  await expect(late.some((preset) => preset.label === "This evening")).toBe(false);
});

test("a duration preset restarts from the pick time", async () => {
  const picked = pickSnoozePreset(presets, "after:60", new Date(2026, 5, 3, 10, 30, 0));
  await expect(Date.parse(picked!.snoozedUntil)).toBe(new Date(2026, 5, 3, 11, 30, 0).getTime());
  await expect(pickSnoozePreset(presets, "after:999", new Date())).toBeUndefined();
});

test("malformed snooze settings fall back to the defaults", async () => {
  await expect(snoozePresetsFromSetting("nope").length).toBe(5);
  await expect(snoozePresetsFromSetting([{ kind: "after", minutes: 5 }]).length).toBe(1);
  await expect(snoozePresetsFromSetting([{ kind: "bogus" }]).length).toBe(5);
});

test("custom snooze rejects the past and bad input", async () => {
  const now = new Date(2026, 5, 3, 10, 0, 0);
  await expect(resolveCustomSnooze({ mode: "duration", amount: "2", unit: "hours" }, now)).toBe(new Date(2026, 5, 3, 12, 0, 0).toISOString());
  await expect(resolveCustomSnooze({ mode: "duration", amount: "0", unit: "hours" }, now)).toBeNull();
  await expect(resolveCustomSnooze({ mode: "duration", amount: "", unit: "days" }, now)).toBeNull();
  await expect(resolveCustomSnooze({ mode: "date", date: "2026-06-03", time: "09:00" }, now)).toBeNull();
  await expect(resolveCustomSnooze({ mode: "date", date: "2026-06-04", time: "09:00" }, now)).toBe(new Date(2026, 5, 4, 9, 0, 0).toISOString());
  await expect(resolveCustomSnooze({ mode: "date", date: "2026-02-31", time: "09:00" }, now)).toBeNull();
  await expect(resolveCustomSnooze({ mode: "date", date: "tomorrow", time: "9" }, now)).toBeNull();
});

test("a thread with a project offers Filter by that project, or Show all projects while it is the scope", async () => {
  const filter = (isActive: boolean) =>
    buildThreadMenu({ ...state, projectFilter: { label: "Alpha", isActive } }).find((item) => item.id === "filter-by-project");
  await expect(filter(false)?.label).toBe("Filter by Alpha");
  await expect(filter(true)?.label).toBe("Show all projects");
  await expect(filter(false)?.icon).toBe("folder-tree");
  await expect(buildThreadMenu(state).some((item) => item.id === "filter-by-project")).toBe(false);
});

test("Turn into project shows only for an eligible thread and is disabled while it runs", async () => {
  await expect(buildThreadMenu(state).some((item) => item.id === "turn-into-project")).toBe(false);
  const eligible = buildThreadMenu({ ...state, canTurnIntoProject: true });
  await expect(eligible.find((item) => item.id === "turn-into-project")?.label).toBe("Turn into project");
  const running = buildThreadMenu({ ...state, canTurnIntoProject: true, isRunning: true });
  await expect(running.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
});

test("Auto-settle behavior offers Follow settings and Never, with the current one checked", async () => {
  const menu = (autoSettleEnabled: boolean) =>
    buildThreadMenu({ ...state, supports: { ...state.supports, autoSettleOptOut: true }, autoSettleEnabled });
  const follow = menu(true).find((item) => item.id === "auto-settle");
  await expect(follow?.label).toBe("Auto-settle behavior");
  await expect(follow?.children?.map((child) => [child.label, child.checked])).toEqual([["Follow settings", true], ["Never", false]]);
  const never = menu(false).find((item) => item.id === "auto-settle");
  await expect(never?.children?.map((child) => child.checked)).toEqual([false, true]);
  await expect(buildThreadMenu(state).some((item) => item.id === "auto-settle")).toBe(false);
});

test("the new items sit after Mark unread and before Copy, as in the web", async () => {
  const menu = buildThreadMenu({
    ...state, projectFilter: { label: "A", isActive: false }, canTurnIntoProject: true,
    supports: { ...state.supports, autoSettleOptOut: true },
  });
  await expect(ids(menu)).toEqual([
    "pin", "settle", "snooze", "rename", "regenerate-title", "mark-unread",
    "filter-by-project", "turn-into-project", "auto-settle", "copy", "project-settings", "archive", "delete",
  ]);
});

test("Find in thread comes first, only when the surface offers it", async () => {
  await expect(ids(buildThreadMenu(state)).includes("find")).toBe(false);
  const menu = buildThreadMenu({ ...state, canFind: true });
  await expect(menu[0]!.id).toBe("find");
  await expect(menu[0]!.label).toBe("Find in thread");
  await expect(menu[0]!.icon).toBe("text-search");
});

test("choosing Find in thread runs the find command through the registry", async () => {
  let found = 0;
  const remove = registerCommand("chat.find", () => { found += 1; });
  const thread: Thread = { id: "t", projectId: "p", title: "T", status: "idle", pinned: false, updatedAt: 0 };
  await runThreadAction("find", { thread, startRename: () => {}, requestCustomSnooze: async () => null, presets: [], newThreadOnBranch: () => {} });
  remove();
  await expect(found).toBe(1);
});

test("the bulk menu counts the selection in each label", async () => {
  const threads: Thread[] = [
    { id: "a", projectId: "p", title: "A", status: "idle", pinned: true, updatedAt: 0 },
    { id: "b", projectId: "p", title: "B", status: "idle", pinned: false, updatedAt: 0 },
    { id: "c", projectId: "p", title: "C", status: "idle", pinned: false, updatedAt: 0 },
  ];
  const menu = buildBulkMenu(bulkMenuState(threads, presets, true));
  await expect(menu.map((item) => item.label)).toEqual([
    "Unpin (1)", "Settle (3)", "Snooze (3)", "Regenerate titles (3)", "Mark unread (3)", "Delete (3)",
  ]);
  await expect(menu[menu.length - 1]!.destructive).toBe(true);
  await expect(menu[2]!.children!.length).toBe(presets.length + 1);
  const offline = buildBulkMenu(bulkMenuState(threads, presets, false));
  await expect(offline.map((item) => item.label)).toEqual(["Unpin (1)", "Settle (3)", "Snooze (3)", "Mark unread (3)", "Delete (3)"]);
  await expect(offline[1]!.disabled).toBe(true);
});

test("the title menu has no Filter by item while the sidebar row's menu does", async () => {
  const thread = { id: "t1", projectId: "p1", title: "T", status: "idle", pinned: false, updatedAt: 0, createdAt: 0 } as Thread;
  const base = { thread, now: Date.now(), connected: true, hasProject: true, presets, project: { id: "p1", name: "legion" }, scopeIds: [] as string[] };
  const row = buildThreadMenu(threadMenuState(base));
  const title = buildThreadMenu(threadMenuState({ ...base, omitProjectFilter: true }));
  await expect(row.find((item) => item.id === "filter-by-project")?.label).toBe("Filter by legion");
  await expect(title.find((item) => item.id === "filter-by-project")).toBeUndefined();
});

test("settling several threads groups into one Settled N notice whose Undo restores every one", async () => {
  const restored: string[] = [];
  for (const id of ["a", "b", "c"]) threadUndo.show("Settled", async () => { restored.push(id); });
  await expect(threadUndo.summary(threadUndo.notice()!)).toBe("Settled 3");
  await threadUndo.run();
  await expect(restored.sort()).toEqual(["a", "b", "c"]);
  await expect(threadUndo.notice()).toBeNull();
});

test("fm13: the notice is announced as a sentence and its button names the undo shortcut", async () => {
  await expect(threadUndo.announcement({ action: "Settled", count: 2 })).toBe("Settled 2 threads");
  await expect(threadUndo.announcement({ action: "Archived", count: 1 })).toBe("Archived 1 thread");
  await expect(threadUndo.announcement({ action: "Discarded", count: 3 })).toBe("Discarded 3 drafts");
  await expect(threadUndo.label()).toMatch(/^(.+ to undo|Undo)$/);
});

test("a failed action raises an error toast with the reason as its description", async () => {
  clearToasts();
  threadActionNotice.failure("Failed to settle thread", new Error("boom"));
  const [toast] = toasts();
  await expect(toast.type).toBe("error");
  await expect(toast.title).toBe("Failed to settle thread");
  await expect(toast.description).toBe("boom");
  clearToasts();
  threadActionNotice.failure("Failed to wake thread", "not an Error");
  await expect(toasts()[0].description).toBe("An error occurred.");
  clearToasts();
});

test("a copy raises a success toast carrying the copied text, and a prepared line splits at the colon", async () => {
  clearToasts();
  threadActionNotice.success("Path copied", "/work/legion");
  await expect(toasts()[0].type).toBe("success");
  await expect(toasts()[0].description).toBe("/work/legion");
  clearToasts();
  threadActionNotice.show("Could not snooze thread: That snooze time has passed.");
  await expect(toasts()[0].type).toBe("error");
  await expect(toasts()[0].title).toBe("Could not snooze thread");
  clearToasts();
});

test("fm13: without orchestration:operate a thread action fails with the reference's reason", async () => {
  const { setSourceControlScopesForTest } = await import("../header/sourceControlScope");
  const { dispatchThreadCommand, THREAD_OPERATE_DENIED } = await import("./threadActions");
  setSourceControlScopesForTest({ orchestrationOperate: false });
  let message = "";
  await dispatchThreadCommand({ type: "thread.pin", threadId: "t" }).catch((error: Error) => { message = error.message; });
  setSourceControlScopesForTest(null);
  await expect(message).toBe(THREAD_OPERATE_DENIED);
});

test("undo claims: a superseding action or a newer one on the thread drops the older Undo from the notice (ThreadUndo claims)", async () => {
  const { threadUndo, expireThreadUndos } = await import("./threadActions");
  const undone: string[] = [];
  threadUndo.show("Unpinned", async () => { undone.push("pin t1"); }, "t1");
  expect(threadUndo.notice()?.action).toBe("Unpinned");
  // Settling the same thread supersedes its unpin Undo.
  threadUndo.show("Settled", async () => { undone.push("settle t1"); }, "t1");
  threadUndo.show("Settled", async () => { undone.push("settle t2"); }, "t2");
  expect(threadUndo.notice()).toMatchObject({ action: "Settled", count: 2 });
  // Pinning t2 by hand expires its settle Undo.
  expireThreadUndos("t2", ["pin", "settle", "snooze"]);
  expect(threadUndo.notice()).toMatchObject({ action: "Settled", count: 1 });
  await threadUndo.run();
  expect(undone).toEqual(["settle t1"]);
  expect(threadUndo.notice()).toBe(null);
});

test("New thread on a branch passes the branch and worktree, and a failure says Could not create thread (useThreadActionMenu)", async () => {
  clearToasts();
  const thread = { id: "t", projectId: "p", title: "T", status: "idle", pinned: false, updatedAt: 0, path: "/tmp/wt", meta: { branch: "feat/x" } } as unknown as Thread;
  const calls: [string, string | null][] = [];
  const base = { thread, startRename: () => {}, requestCustomSnooze: async () => null, presets: [] };
  await runThreadAction("new-thread-on-branch", { ...base, newThreadOnBranch: (branch, worktreePath) => { calls.push([branch, worktreePath]); } });
  await expect(calls).toEqual([["feat/x", "/tmp/wt"]]);
  await expect(toasts().length).toBe(0);
  await runThreadAction("new-thread-on-branch", { ...base, newThreadOnBranch: async () => { throw new Error("Project is no longer available"); } });
  const last = toasts()[toasts().length - 1];
  await expect(last?.title).toBe("Could not create thread");
  await expect(last?.description).toBe("Project is no longer available");
  clearToasts();
});
