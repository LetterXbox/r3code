#!/usr/bin/env python3
"""Exercise the live sidebar components with an isolated, in-memory store."""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "t3ui"

STORE = r'''
import { signal } from "nsh";
export const title = signal("Example thread");
export const pinned = signal(false);
export const archived = signal(false);
export const archiveMode = signal<"normal" | "delayed" | "fail">("normal");
export const archiveCalls = signal(0);
export const fixtureConnection = signal<"disconnected" | "connecting" | "connected" | "error">("disconnected");
export const fixtureRoute = signal("");
export const fixtureEndpoint = signal("ws://fixture-one/ws");
export function backendStatus() { return fixtureConnection(); }
export function subscribeBackend(_method: string, _payload: unknown, _onValue: (value: unknown) => void, _onError: (error: Error) => void) { return () => {}; }
export function backendUrl() { return fixtureEndpoint(); }
export const backendConnectionGeneration = () => 0;
export function openSettings(path: string) { fixtureRoute.set(path); }
export function renameThread(_id: string, value: string) { title.set(value); }
export function setThreadPinned(_id: string, value: boolean) { pinned.set(value); }
export async function archiveThread(_id: string) {
  archiveCalls.update((count) => count + 1);
  if (archiveMode() === "delayed") await new Promise((resolve) => setTimeout(resolve, 500));
  if (archiveMode() === "fail") throw new Error("Archive failed");
  archived.set(true);
}
export function settingValue(_field: string) { return "locale"; }
export async function restoreThread(_id: string) { archived.set(false); }
export function setWorkspaceStrategy(_next: unknown) {}
export function createThread(id: string | null) { created.set(id ?? "none"); }
let searchFailsOnce = true;
export async function requestBackend(method: string, payload: unknown): Promise<unknown> {
  if (method === "orchestration.searchThreads") {
    if (typeof payload !== "object" || payload === null || !("query" in payload) || typeof payload.query !== "string") {
      throw new Error("Invalid search");
    }
    const query = payload.query;
    const found = (snippet: string) => ({ matches: [{ threadId: "two", projectId: "project", source: "user", snippet }] });
    if (query === "slow") return new Promise((resolve) => setTimeout(() => resolve(found("stale result")), 800));
    if (query === "fresh") return found("fresh result");
    if (query === "needle") return found("secret needle in this message");
    if (query === "retry") {
      if (searchFailsOnce) { searchFailsOnce = false; throw new Error("Search temporarily unavailable"); }
      return found("retry result");
    }
    if (query === "invalid") return { matches: "bad" };
    return { matches: [] };
  }
  if (method !== "filesystem.browse" || typeof payload !== "object" || payload === null ||
      !("partialPath" in payload) || typeof payload.partialPath !== "string") {
    throw new Error("Unexpected request");
  }
  const path = payload.partialPath;
  if (path === "/forbidden/") throw new Error("Folder access denied");
  if (path === "/broken/") return { entries: "invalid" };
  if (path === "/slow/") {
    return new Promise((resolve) => setTimeout(() => resolve({ parentPath: "/slow", entries: [] }), 300));
  }
  if (path === "./repo/" && "cwd" in payload && payload.cwd === "/home/developer/work") {
    return { parentPath: "/home/developer/work/repo", entries: [] };
  }
  if (path === "/home/developer/work/") {
    return { parentPath: "/home/developer/work", entries: [
      { name: "repo", fullPath: "/home/developer/work/repo" },
    ] };
  }
  if (path === "/home/developer/work/repo/") {
    return { parentPath: "/home/developer/work/repo", entries: [] };
  }
  if (path === "~/" || path === "/home/developer/") {
    return { parentPath: "/home/developer", entries: [
      { name: "work", fullPath: "/home/developer/work" },
      { name: ".private", fullPath: "/home/developer/.private" },
    ] };
  }
  throw new Error("Folder not found");
}
export interface Thread { id: string; projectId: string; title: string; status: "idle"; pinned: boolean; updatedAt: number }
export interface Project { id: string; name: string; path?: string; pinned?: boolean; threads: Thread[] }
export const project = signal<Project>({ id: "project", name: "Alpha Beta", path: "/home/developer/work", threads: [
  { id: "one", projectId: "project", title: "First thread", status: "idle", pinned: false, updatedAt: Date.now() },
  { id: "two", projectId: "project", title: "Second thread", status: "idle", pinned: false, updatedAt: Date.now() },
] });
export const created = signal("");
export const createCalls = signal(0);
export const selected = signal("one");
export const query = signal("");
export const draftText = signal("Build the search\nsecond line");
export const draftAttachmentCount = signal(0);
export const draftExists = signal(true);
export const draftUndoAvailable = signal(false);
export const draftDiscardMode = signal<"normal" | "fail" | "delayed">("normal");
export const draftUndoFails = signal(false);
export const draftDiscardCalls = signal(0);
const collapsed = signal(false);
export function draftSummary(_id: string) {
  return { text: draftText(), attachmentCount: draftAttachmentCount() };
}
export async function discardDraft(_id: string) {
  draftDiscardCalls.update((count) => count + 1);
  if (draftDiscardMode() === "delayed") await new Promise((resolve) => setTimeout(resolve, 500));
  if (draftDiscardMode() === "fail") throw new Error("Discard failed");
  draftExists.set(false);
  draftUndoAvailable.set(true);
}
export function canUndoDiscardDraft() { return draftUndoAvailable(); }
export async function undoDiscardDraft() {
  if (draftUndoFails()) throw new Error("Undo failed");
  draftExists.set(true);
  draftUndoAvailable.set(false);
}
export function activeProjectId() { return project().id; }
export function allProjects() { return [project()]; }
export function allThreads() { return project().threads; }
export function threadById(id: string) { return allThreads().find((thread) => thread.id === id); }
export function projectOrganizationSupported() { return true; }
export async function setProjectPinned(_id: string, pinned: boolean) {
  project.update((current) => ({ ...current, pinned }));
}
export async function createProject(path: string) {
  createCalls.update((count) => count + 1);
  if (path === "/missing") throw new Error("Folder not found");
  if (path === "/slow-create") await new Promise((resolve) => setTimeout(resolve, 500));
  created.set(path);
}
export function isCollapsed(_id: string) { return collapsed(); }
export function toggleProject(_id: string) { collapsed.set(!collapsed()); }
export function openThread() { return project().threads.find((thread) => thread.id === selected()); }
export function openThreadById(id: string) { selected.set(id); }
export function sidebarThreadQuery() { return query(); }
export function sidebarProjects() { return [project()]; }
export function threadMatchesQuery(title: string) { return title.toLowerCase().includes(query().trim().toLowerCase()); }
export function unpinnedLooseThreads() { return []; }
export function setSidebarThreadQuery(text: string) { query.set(text); }
export function visibleProjectThreads(project: Project) {
  return project.threads.filter((thread) => thread.title.toLowerCase().includes(query().toLowerCase()));
}
'''

THREAD_APP = r'''
import { mount, Text, View } from "nsh";
import { SidebarThreadRow } from "./components/SidebarThreadRow";
import { title, pinned, archived, archiveMode, archiveCalls, fixtureConnection } from "./store";
fixtureConnection.set("connected");
function App() {
  return <View class="w-[256px] bg-sidebar">
    {archived() ? <Text>Archived</Text> :
      <SidebarThreadRow thread={{ id: "one", projectId: "project", title: title(), status: "idle", pinned: pinned(), updatedAt: Date.now() }} variant="folder" active={false} projectName="Alpha Beta" onPress={() => {}} />}
    <View accessibilityLabel="Delay archive" onPress={() => archiveMode.set("delayed")}><Text>Delay</Text></View>
    <View accessibilityLabel="Fail archive" onPress={() => archiveMode.set("fail")}><Text>Fail</Text></View>
    <Text>Archive requests: {archiveCalls()}</Text>
  </View>;
}
mount(App);
'''

PROJECT_APP = r'''
import { mount, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SidebarProjectFolder } from "./components/SidebarProjectFolder";
import { sidebarProjectSettingsId } from "./components/SidebarProjectSettingsState";
import { created, project, query, setSidebarThreadQuery, fixtureRoute } from "./store";
function App() {
  return <View class="w-[256px] bg-sidebar">
    <Input accessibilityLabel="Search" value={query()} onChange={(event) => setSidebarThreadQuery(event.value)} />
    <SidebarProjectFolder project={() => project()} />
    <Text>Created: {created()}</Text>
    <Text>Route: {fixtureRoute()}</Text>
    <Text>Settings project: {sidebarProjectSettingsId() ?? "none"}</Text>
  </View>;
}
mount(App);
'''

PROJECT_SETTINGS_APP = r'''
import { mount, signal, Text, View } from "nsh";
import { SidebarProjectSettings } from "./components/SidebarProjectSettings";
import { ConfirmDialogHost } from "./components/toast/ConfirmDialogHost";
import { fixtureEndpoint, project } from "./store";
const isOpen = signal(true);
const renameMode = signal<"normal" | "fail" | "delay">("normal");
const removeMode = signal<"normal" | "fail" | "delay">("normal");
const renameCalls = signal(0);
const removeCalls = signal(0);
async function rename(id: string, title: string) {
  renameCalls.update((n) => n + 1);
  if (renameMode() === "delay") await new Promise((resolve) => setTimeout(resolve, 500));
  if (renameMode() === "fail") throw new Error("Rename failed");
  if (project().id === id) project.update((current) => ({ ...current, name: title }));
}
async function remove(_id: string) {
  removeCalls.update((n) => n + 1);
  if (removeMode() === "delay") await new Promise((resolve) => setTimeout(resolve, 500));
  if (removeMode() === "fail") throw new Error("Remove failed");
}
function App() {
  return <View class="flex-1">
    <ConfirmDialogHost />
    {isOpen() ? <SidebarProjectSettings project={() => project()} onBack={() => isOpen.set(false)} onRename={rename} onRemove={remove} /> : <Text>Project list</Text>}
    <View accessibilityLabel="Fail rename fixture" onPress={() => renameMode.set("fail")}><Text>Fail rename</Text></View>
    <View accessibilityLabel="Delay rename fixture" onPress={() => renameMode.set("delay")}><Text>Delay rename</Text></View>
    <View accessibilityLabel="Fail removal fixture" onPress={() => removeMode.set("fail")}><Text>Fail removal</Text></View>
    <View accessibilityLabel="Delay removal fixture" onPress={() => removeMode.set("delay")}><Text>Delay removal</Text></View>
    <View accessibilityLabel="Switch environment shortly" onPress={() => setTimeout(() => fixtureEndpoint.set("ws://fixture-two/ws"), 300)}><Text>Switch later</Text></View>
    <Text>Project: {project().name}</Text>
    <Text>Rename requests: {renameCalls()}</Text>
    <Text>Remove requests: {removeCalls()}</Text>
  </View>;
}
mount(App);
'''

SEARCH_APP = r'''
import { mount, Text, View } from "nsh";
import { Input } from "nsh/base";
import { createSidebarThreadSearch, SidebarThreadSearch } from "./components/SidebarThreadSearch";
import { fixtureConnection, query, selected, setSidebarThreadQuery, openThreadById } from "./store";
function App() {
  const search = createSidebarThreadSearch();
  return <View class="w-[256px] bg-sidebar">
    <View accessibilityLabel="Connect fixture" onPress={() => fixtureConnection.set("connected")}><Text>Connect fixture</Text></View>
    <Input accessibilityLabel="Search" value={query()} onChange={(event) => setSidebarThreadQuery(event.value)} />
    <SidebarThreadSearch search={search} onSelect={(id) => { openThreadById(id); setSidebarThreadQuery(""); }} />
    <Text>Selected: {selected()}</Text>
  </View>;
}
mount(App);
'''

TITLEBAR_APP = r'''
import { mount, Text, View } from "nsh";
import { titleBar, Window } from "nsh/desktop";
Window.setTitle("T3 Code");
Window.setTitleBar({ style: "hidden", height: 52 });
function App() {
  return <View class="flex-1" desktop={{ windowDrag: true }}>
    <Text>{"Titlebar left " + titleBar().left + " height " + titleBar().height}</Text>
  </View>;
}
mount(App);
'''

DRAFT_APP = r'''
import { mount, Text, View } from "nsh";
import { SidebarDraftRow } from "./components/SidebarDraftRow";
import { SidebarDraftUndo } from "./components/SidebarDraftUndo";
import { draftAttachmentCount, draftDiscardCalls, draftDiscardMode, draftExists, draftText, draftUndoFails, project } from "./store";
function App() {
  return <View class="w-[256px] bg-sidebar">
    {draftExists() ? <SidebarDraftRow thread={() => project().threads[0]} active={true} onSelect={() => {}} /> : null}
    <SidebarDraftUndo />
    <View accessibilityLabel="Attachment-only fixture" onPress={() => { draftText.set(""); draftAttachmentCount.set(2); }}><Text>Use attachments</Text></View>
    <View accessibilityLabel="Fail discard fixture" onPress={() => draftDiscardMode.set("fail")}><Text>Fail discard</Text></View>
    <View accessibilityLabel="Fail undo fixture" onPress={() => draftUndoFails.set(true)}><Text>Fail undo</Text></View>
    <View accessibilityLabel="Delay discard fixture" onPress={() => draftDiscardMode.set("delayed")}><Text>Delay discard</Text></View>
    <Text>Draft content: {draftText()}</Text>
    <Text>Discard requests: {draftDiscardCalls()}</Text>
  </View>;
}
mount(App);
'''

ADD_PROJECT_APP = r'''
import { mount, Text, View } from "nsh";
import { SidebarAddProject } from "./components/SidebarAddProject";
import { showAddProject } from "./components/SidebarAddProjectState";
import { created, createCalls } from "./store";
function App() {
  return <View class="relative flex-1">
    <View accessibilityLabel="Open add project" onPress={showAddProject}><Text>Open</Text></View>
    <Text>Created: {created()}</Text>
    <Text>Create requests: {createCalls()}</Text>
    <SidebarAddProject />
  </View>;
}
mount(App);
'''

THREAD_TESTS = r'''
import { expect, open, test } from "nsh/test";
test("right click can pin and unpin a thread", async () => {
  const app = await open("./ThreadApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.rightClick("label:Example thread, Alpha Beta");
  await app.press("label:Pin thread");
  await app.rightClick("label:Example thread, Alpha Beta");
  await expect(app.shows("label:Unpin thread")).toBe(true);
  await app.press("label:Unpin thread >> nth=1");
  await app.rightClick("label:Example thread, Alpha Beta");
  await expect(app.shows("label:Pin thread")).toBe(true);
});
test("right click can rename a thread", async () => {
  const app = await open("./ThreadApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.rightClick("label:Example thread, Alpha Beta");
  await app.press("label:Rename thread");
  await app.clear("label:Thread name");
  await app.type("label:Thread name", "A new title");
  await app.submit("label:Thread name");
  await expect(app.texts()).toContain("A new title");
});
test("right click can archive a thread", async () => {
  const app = await open("./ThreadApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.rightClick("label:Example thread, Alpha Beta");
  await app.press("label:Archive thread");
  await expect(app.texts()).toContain("Archived");
});
test("archive cannot be submitted twice while a request is pending", async () => {
  const app = await open("./ThreadApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.press("label:Delay archive");
  await app.rightClick("label:Example thread, Alpha Beta");
  await app.press("label:Archive thread");
  await app.rightClick("label:Example thread, Alpha Beta");
  await expect(app.enabled("label:Archive thread")).toBe(false);
  await expect(app.texts()).toContain("Archive requests: 1");
});
test("an archive failure can be retried without an unhandled rejection", async () => {
  const app = await open("./ThreadApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.press("label:Fail archive");
  await app.rightClick("label:Example thread, Alpha Beta");
  await app.press("label:Archive thread");
  await app.rightClick("label:Example thread, Alpha Beta");
  await expect(app.enabled("label:Archive thread")).toBe(true);
  await expect(app.texts()).toContain("Archive requests: 1");
});
test("hovering a row adds no ellipsis button; the thread menu is the right-click menu", async () => {
  const app = await open("./ThreadApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.hover("label:Example thread, Alpha Beta");
  await expect(app.shows("label:Actions for Example thread")).toBe(false);
});
test("keyboard focus reaches the row and Enter opens it", async () => {
  const app = await open("./ThreadApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.keyboard.press("tab");
  await expect(app.shows("label:Actions for Example thread")).toBe(false);
});
test("the hover card carries no timestamp", async () => {
  const app = await open("./ThreadApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.hover("label:Example thread, Alpha Beta");
  await app.wait(700);
  await expect(app.texts().join(" ").includes(String(new Date().getFullYear()))).toBe(false);
});
'''

PROJECT_TESTS = r'''
import { expect, open, test } from "nsh/test";
test("a collapsed project retains the selected thread and shows its hidden count", async () => {
  const app = await open("./ProjectApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.press("label:Collapse Alpha Beta");
  await expect(app.texts()).toContain("First thread");
  await expect(app.texts()).not.toContain("Second thread");
  await expect(app.texts()).toContain("1");
  await app.press("label:Expand Alpha Beta");
  await expect(app.texts()).toContain("Second thread");
});
test("a project creates its own new thread", async () => {
  const app = await open("./ProjectApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.hover("label:Collapse Alpha Beta");
  await app.press("label:New thread in Alpha Beta");
  await expect(app.texts()).toContain("Created: project");
});
test("project context menu copies its path", async () => {
  const app = await open("./ProjectApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.rightClick("label:Collapse Alpha Beta");
  await app.press("label:Copy project path");
  await expect(app.clipboard()).toBe("/home/developer/work");
  await expect(app.texts()).toContain("Path copied");
});
test("project context menu opens project settings", async () => {
  const app = await open("./ProjectApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.rightClick("label:Collapse Alpha Beta");
  await app.press("label:Open project settings");
  await expect(app.texts()).toContain("Route: /settings/projects");
  await expect(app.texts()).toContain("Settings project: project");
});
test("project context menu pins and unpins a project", async () => {
  const app = await open("./ProjectApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.rightClick("label:Collapse Alpha Beta");
  await app.press("label:Pin project");
  await app.rightClick("label:Collapse Alpha Beta");
  await expect(app.shows("label:Unpin project")).toBe(true);
  await app.press("label:Unpin project");
  await app.rightClick("label:Collapse Alpha Beta");
  await expect(app.shows("label:Pin project")).toBe(true);
});
test("the project header has no ellipsis button", async () => {
  const app = await open("./ProjectApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.hover("label:Collapse Alpha Beta");
  await expect(app.shows("label:New thread in Alpha Beta")).toBe(true);
  await expect(app.shows("label:Actions for project Alpha Beta")).toBe(false);
});
test("keyboard focus reaches the project new-thread action", async () => {
  const app = await open("./ProjectApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await expect(app.shows("label:New thread in Alpha Beta")).toBe(true);
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await expect(app.texts()).toContain("Created: project");
});
test("search expands a collapsed project until the query clears", async () => {
  const app = await open("./ProjectApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.press("label:Collapse Alpha Beta");
  await app.type("label:Search", "Second");
  await expect(app.texts()).toContain("Second thread");
  await app.press("label:Second thread, Alpha Beta");
  await expect(app.value("label:Search")).toBe("");
});
'''

PROJECT_SETTINGS_TESTS = r'''
import { expect, open, test } from "nsh/test";
test("project name validates and saves the trimmed title", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.clear("label:Project name");
  await app.submit("label:Project name");
  await expect(app.texts()).toContain("Project name cannot be empty.");
  await expect(app.texts()).toContain("Rename requests: 0");
  await app.type("label:Project name", "  Renamed project  ");
  await app.submit("label:Project name");
  await expect(app.texts()).toContain("Project: Renamed project");
  await expect(app.texts()).toContain("Rename requests: 1");
});
test("a failed rename keeps the entered name and explains the error", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Fail rename fixture");
  await app.clear("label:Project name");
  await app.type("label:Project name", "New name");
  await app.submit("label:Project name");
  await expect(app.texts()).toContain("Could not rename project. Try again.");
  await expect(app.value("label:Project name")).toBe("New name");
  await expect(app.texts()).toContain("Project: Alpha Beta");
});
test("the save button commits an edited name", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.clear("label:Project name");
  await app.type("label:Project name", "Saved explicitly");
  await app.press("label:Save project name");
  await expect(app.texts()).toContain("Project: Saved explicitly");
  await expect(app.texts()).toContain("Rename requests: 1");
});
test("Back saves an edit before leaving the selected project", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.clear("label:Project name");
  await app.type("label:Project name", "Saved on back");
  await app.press("label:Back to projects");
  await expect(app.texts()).toContain("Project: Saved on back");
  await expect(app.texts()).toContain("Project list");
});
test("a save finishing in another environment does not navigate", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Delay rename fixture");
  await app.clear("label:Project name");
  await app.type("label:Project name", "Saved on back");
  await app.press("label:Switch environment shortly");
  await app.press("label:Back to projects");
  await app.wait(550);
  await expect(app.texts()).not.toContain("Project list");
});
test("a pending rename disables editing and removal", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Delay rename fixture");
  await app.clear("label:Project name");
  await app.type("label:Project name", "New name");
  await app.submit("label:Project name");
  await expect(app.enabled("label:Project name")).toBe(false);
  await expect(app.enabled("label:Remove project")).toBe(false);
  await expect(app.texts()).toContain("Rename requests: 1");
});
test("leaving the name field saves before removal can begin", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Delay rename fixture");
  await app.clear("label:Project name");
  await app.type("label:Project name", "New name");
  await app.press("label:Remove project");
  await expect(app.texts()).toContain("Rename requests: 1");
  await expect(app.texts()).toContain("Remove requests: 0");
  await expect(app.shows("label:Confirm")).toBe(false);
});
test("removal describes its impact and cancel never removes", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Remove project");
  await expect(app.texts().join(" ").includes("all its active and archived threads, and its unsent drafts")).toBe(true);
  await expect(app.texts().join(" ").includes("Files on disk are not touched")).toBe(true);
  await app.press("label:Cancel");
  await expect(app.texts()).toContain("Remove requests: 0");
  await expect(app.shows("label:Project name")).toBe(true);
});
test("confirmation removes once and returns to the project list", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Delay removal fixture");
  await app.press("label:Remove project");
  await app.press("label:Confirm");
  await expect(app.texts()).toContain("Remove requests: 1");
  await app.wait(550);
  await expect(app.texts()).toContain("Project list");
});
test("a failed removal remains on the project page with an error", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Fail removal fixture");
  await app.press("label:Remove project");
  await app.press("label:Confirm");
  await expect(app.texts()).toContain("Could not remove project. Try again.");
  await expect(app.shows("label:Project name")).toBe(true);
});
test("a confirmation cannot remove a project after the environment changes", async () => {
  const app = await open("./ProjectSettingsApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Switch environment shortly");
  await app.press("label:Remove project");
  await app.wait(350);
  await app.press("label:Confirm");
  await expect(app.texts()).toContain("Remove requests: 0");
  await expect(app.texts()).toContain("The environment changed. Open project settings again.");
});
'''

SEARCH_TESTS = r'''
import { expect, open, test } from "nsh/test";
test("local title results appear without waiting for the server", async () => {
  const app = await open("./SearchApp.tsx", { width: 400, height: 500, platform: "macos" });
  await app.type("label:Search", "First");
  await expect(app.shows("label:Open search result First thread")).toBe(true);
  await expect(app.shows("label:Open search result Second thread")).toBe(false);
});
test("message search shows the server excerpt and opens the matching thread", async () => {
  const app = await open("./SearchApp.tsx", { width: 400, height: 500, platform: "macos" });
  await app.press("label:Connect fixture");
  await app.type("label:Search", "needle");
  await app.waitFor("label:Open search result Second thread");
  await expect(app.texts().join(" ").includes("secret needle in this message")).toBe(true);
  await app.press("label:Open search result Second thread");
  await expect(app.texts()).toContain("Selected: two");
  await expect(app.value("label:Search")).toBe("");
});
test("older search responses cannot replace a newer query", async () => {
  const app = await open("./SearchApp.tsx", { width: 400, height: 500, platform: "macos" });
  await app.press("label:Connect fixture");
  await app.type("label:Search", "slow");
  await app.wait(220);
  await expect(app.texts()).toContain("Searching thread messages...");
  await app.clear("label:Search");
  await app.type("label:Search", "fresh");
  await app.waitFor("label:Open search result Second thread");
  await app.wait(900);
  await expect(app.texts().join(" ").includes("fresh result")).toBe(true);
  await expect(app.texts().join(" ").includes("stale result")).toBe(false);
});
test("search errors can be retried", async () => {
  const app = await open("./SearchApp.tsx", { width: 400, height: 500, platform: "macos" });
  await app.press("label:Connect fixture");
  await app.type("label:Search", "retry");
  await app.waitFor("text:Search temporarily unavailable");
  await app.press("label:Retry thread search");
  await app.waitFor("label:Open search result Second thread");
  await expect(app.texts().join(" ").includes("retry result")).toBe(true);
});
test("invalid search responses are displayed as an error", async () => {
  const app = await open("./SearchApp.tsx", { width: 400, height: 500, platform: "macos" });
  await app.press("label:Connect fixture");
  await app.type("label:Search", "invalid");
  await app.waitFor("text:The environment returned invalid search results.");
  await expect(app.shows("label:Retry thread search")).toBe(true);
});
'''

TITLEBAR_TESTS = r'''
import { expect, open, test } from "nsh/test";
test("hidden titlebar retains a native controls inset", async () => {
  const app = await open("./TitlebarApp.tsx", { width: 400, height: 200, platform: "macos" });
  await app.wait(100);
  const text = app.texts().find((value) => value.startsWith("Titlebar left ")) ?? "";
  const match = text.match(/^Titlebar left (\d+(?:\.\d+)?) height (\d+(?:\.\d+)?)$/);
  await expect(Boolean(match)).toBe(true);
  await expect(Number(match?.[1]) > 0).toBe(true);
  await expect(Number(match?.[2]) > 0).toBe(true);
});
'''

DRAFT_TESTS = r'''
import { expect, open, test } from "nsh/test";
test("a draft card previews its first line and can be discarded and restored", async () => {
  const app = await open("./DraftApp.tsx", { width: 400, height: 400, platform: "macos" });
  await expect(app.texts()).toContain("Build the search");
  await app.hover("label:Unsent draft: Build the search");
  await app.press("label:Discard draft");
  await expect(app.shows("label:Unsent draft: Build the search")).toBe(false);
  await expect(app.shows("label:Undo discard draft")).toBe(true);
  await app.press("label:Undo discard draft");
  await expect(app.shows("label:Unsent draft: Build the search")).toBe(true);
  await expect(app.texts().join(" ").includes("second line")).toBe(true);
});
test("a draft with attachments and no text describes the attachments", async () => {
  const app = await open("./DraftApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.press("label:Attachment-only fixture");
  await expect(app.shows("label:Unsent draft: 2 attachments")).toBe(true);
  await expect(app.texts()).toContain("2 attachments");
});
test("a failed discard retains the draft and does not offer undo", async () => {
  const app = await open("./DraftApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.press("label:Fail discard fixture");
  await app.hover("label:Unsent draft: Build the search");
  await app.press("label:Discard draft");
  await expect(app.shows("label:Unsent draft: Build the search")).toBe(true);
  await expect(app.shows("label:Undo discard draft")).toBe(false);
  await expect(app.texts()).toContain("Could not discard draft. Try again.");
});
test("a failed undo stays available and shows an error", async () => {
  const app = await open("./DraftApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.press("label:Fail undo fixture");
  await app.hover("label:Unsent draft: Build the search");
  await app.press("label:Discard draft");
  await app.press("label:Undo discard draft");
  await expect(app.texts()).toContain("Could not undo.");
  await expect(app.shows("label:Undo discard draft")).toBe(true);
});
test("keyboard focus reaches the discard action", async () => {
  const app = await open("./DraftApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.keyboard.press("tab");
  await expect(app.shows("label:Discard draft")).toBe(true);
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await expect(app.shows("label:Undo discard draft")).toBe(true);
});
test("a pending discard cannot be submitted twice", async () => {
  const app = await open("./DraftApp.tsx", { width: 400, height: 400, platform: "macos" });
  await app.press("label:Delay discard fixture");
  await app.hover("label:Unsent draft: Build the search");
  await app.press("label:Discard draft");
  await expect(app.enabled("label:Discard draft")).toBe(false);
  await expect(app.texts()).toContain("Discard requests: 1");
});
'''

ADD_PROJECT_TESTS = r'''
import { expect, open, test } from "nsh/test";
test("adding a project sends the path and closes the dialog", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 400, platform: "macos" });
  await app.press("label:Open add project");
  await app.type("label:Project folder path", "/workspace/project");
  await app.press("label:Confirm add project");
  await expect(app.texts()).toContain("Created: /workspace/project");
  await expect(app.shows("label:Project folder path")).toBe(false);
});
test("a failed project creation preserves the path for correction", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 400, platform: "macos" });
  await app.press("label:Open add project");
  await app.type("label:Project folder path", "/missing");
  await app.submit("label:Project folder path");
  await expect(app.texts()).toContain("Folder not found");
  await expect(app.value("label:Project folder path")).toBe("/missing");
  await app.clear("label:Project folder path");
  await app.type("label:Project folder path", "/workspace/project");
  await app.submit("label:Project folder path");
  await expect(app.texts()).toContain("Created: /workspace/project");
});
test("the folder browser enters folders and adds the selected project", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 600, platform: "macos" });
  await app.press("label:Open add project");
  await app.press("label:Browse project folders");
  await expect(app.value("label:Project folder path")).toBe("/home/developer");
  await expect(app.shows("label:Open folder .private")).toBe(false);
  await app.press("label:Open folder work");
  await expect(app.value("label:Project folder path")).toBe("/home/developer/work");
  await app.press("label:Open folder repo");
  await expect(app.value("label:Project folder path")).toBe("/home/developer/work/repo");
  await app.press("label:Confirm add project");
  await expect(app.texts()).toContain("Created: /home/developer/work/repo");
});
test("the folder browser navigates up and can show hidden folders", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 600, platform: "macos" });
  await app.press("label:Open add project");
  await app.press("label:Browse project folders");
  await app.press("label:Open folder work");
  await app.press("label:Go to parent folder");
  await expect(app.value("label:Project folder path")).toBe("/home/developer");
  await app.press("label:Show hidden folders");
  await expect(app.shows("label:Open folder .private")).toBe(true);
  await app.press("label:Hide hidden folders");
  await expect(app.shows("label:Open folder .private")).toBe(false);
});
test("folder filtering narrows results and a dot finds hidden folders", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 600, platform: "macos" });
  await app.press("label:Open add project");
  await app.press("label:Browse project folders");
  await app.type("label:Filter folders", "wo");
  await expect(app.shows("label:Open folder work")).toBe(true);
  await expect(app.shows("label:Open folder .private")).toBe(false);
  await app.clear("label:Filter folders");
  await app.type("label:Filter folders", ".p");
  await expect(app.shows("label:Open folder .private")).toBe(true);
  await expect(app.shows("label:Open folder work")).toBe(false);
});
test("folder browsing reports permission and malformed response errors", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 600, platform: "macos" });
  await app.press("label:Open add project");
  await app.type("label:Project folder path", "/forbidden");
  await app.press("label:Browse project folders");
  await expect(app.texts()).toContain("Folder access denied");
  await expect(app.value("label:Project folder path")).toBe("/forbidden");
  await app.clear("label:Project folder path");
  await app.type("label:Project folder path", "/broken");
  await app.press("label:Browse project folders");
  await expect(app.texts()).toContain("The environment returned an invalid folder listing.");
});
test("a late folder response does not overwrite an edited path", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 600, platform: "macos" });
  await app.press("label:Open add project");
  await app.type("label:Project folder path", "/slow");
  await app.press("label:Browse project folders");
  await expect(app.shows("text:Loading folders...")).toBe(true);
  await expect(app.enabled("label:Confirm add project")).toBe(false);
  await app.clear("label:Project folder path");
  await app.type("label:Project folder path", "/workspace/chosen");
  await app.wait(350);
  await expect(app.value("label:Project folder path")).toBe("/workspace/chosen");
});
test("cancelling a pending folder request leaves the next dialog clean", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 600, platform: "macos" });
  await app.press("label:Open add project");
  await app.type("label:Project folder path", "/slow");
  await app.press("label:Browse project folders");
  await expect(app.shows("text:Loading folders...")).toBe(true);
  await app.press("label:Cancel adding project");
  await app.press("label:Open add project");
  await app.wait(350);
  await expect(app.value("label:Project folder path")).toBe("");
  await expect(app.shows("text:Loading folders...")).toBe(false);
  await expect(app.shows("label:Filter folders")).toBe(false);
});
test("relative folder browsing uses the current project directory", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 600, platform: "macos" });
  await app.press("label:Open add project");
  await app.type("label:Project folder path", "./repo");
  await app.press("label:Browse project folders");
  await expect(app.value("label:Project folder path")).toBe("/home/developer/work/repo");
});
test("adding a project prevents duplicate submissions and edits while pending", async () => {
  const app = await open("./AddProjectApp.tsx", { width: 600, height: 600, platform: "macos" });
  await app.press("label:Open add project");
  await app.type("label:Project folder path", "/slow-create");
  await app.press("label:Confirm add project");
  await expect(app.enabled("label:Project folder path")).toBe(false);
  await expect(app.enabled("label:Confirm add project")).toBe(false);
  await expect(app.enabled("label:Cancel adding project")).toBe(false);
  await expect(app.texts()).toContain("Create requests: 1");
  await app.wait(550);
  await expect(app.texts()).toContain("Created: /slow-create");
});
'''



def main():
    with tempfile.TemporaryDirectory(prefix="t3-sidebar-") as directory:
        target = Path(directory)
        components = target / "components"
        components.mkdir()
        for name in (
            "Icons.tsx", "SidebarThreadRow.tsx", "SidebarProjectFolder.tsx",
            "SidebarUtils.ts", "SidebarIcon.tsx", "SidebarAddProject.tsx", "SidebarAddProjectState.ts",
            "SidebarFolderBrowserLogic.ts", "SidebarThreadSearch.tsx", "SidebarThreadSearchLogic.ts",
            "SidebarDraftRow.tsx", "SidebarDraftUndo.tsx", "SidebarProjectSettings.tsx",
            "SidebarProjectSettingsState.ts", "SettingsLayout.tsx",
        ):
            shutil.copy2(SOURCE / "components" / name, components / name)
        (target / "commands").mkdir()
        (target / "commands" / "registry.ts").write_text("export function runCommand(_command: string): boolean { return false; }\n")
        (target / "pages" / "settings").mkdir(parents=True)
        shutil.copy2(SOURCE / "pages" / "settings" / "SettingsIcon.tsx", target / "pages" / "settings" / "SettingsIcon.tsx")
        shutil.copytree(SOURCE / "icons", target / "icons")
        shutil.copytree(SOURCE / "components" / "toast", components / "toast", ignore=shutil.ignore_patterns("*.test.*"))
        shutil.copytree(SOURCE / "components" / "sidebar", components / "sidebar", ignore=shutil.ignore_patterns("*.test.*", "RowFixture.tsx"))
        for name in ("nsh.json", "theme.json"):
            shutil.copy2(SOURCE / name, target / name)
        for name, content in (
            ("store.ts", STORE), ("App.tsx", THREAD_APP), ("ThreadApp.tsx", THREAD_APP),
            ("ProjectApp.tsx", PROJECT_APP), ("AddProjectApp.tsx", ADD_PROJECT_APP), ("SearchApp.tsx", SEARCH_APP),
            ("ProjectSettingsApp.tsx", PROJECT_SETTINGS_APP),
            ("TitlebarApp.tsx", TITLEBAR_APP),
            ("DraftApp.tsx", DRAFT_APP),
            ("thread.test.tsx", THREAD_TESTS), ("project.test.tsx", PROJECT_TESTS),
            ("add-project.test.tsx", ADD_PROJECT_TESTS), ("search.test.tsx", SEARCH_TESTS),
            ("titlebar.test.tsx", TITLEBAR_TESTS),
            ("draft.test.tsx", DRAFT_TESTS),
            ("project-settings.test.tsx", PROJECT_SETTINGS_TESTS),
        ):
            (target / name).write_text(content)
        selected = os.environ.get("SIDEBAR_TEST_FILE")
        target_platform = os.environ.get("SIDEBAR_TEST_TARGET")
        test_filter = os.environ.get("SIDEBAR_TEST_FILTER")
        test_names = ("thread.test.tsx", "project.test.tsx", "add-project.test.tsx", "search.test.tsx", "draft.test.tsx", "project-settings.test.tsx")
        if selected == "titlebar.test.tsx":
            test_names = ("titlebar.test.tsx",)
        elif selected and selected not in test_names:
            raise SystemExit(f"Unknown sidebar test file: {selected}")
        for name in test_names:
            if selected and name != selected:
                continue
            command = ["nsh", "test", name]
            if target_platform:
                command.extend(["--target", target_platform])
            if test_filter:
                command.extend(["--filter", test_filter])
            subprocess.run(command, cwd=target, check=True)


if __name__ == "__main__":
    main()
