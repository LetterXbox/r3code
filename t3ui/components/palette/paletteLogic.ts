// Pure palette model, ported from CommandPalette.logic.ts and the item builders
// (CommandPaletteThreadItems, CommandPaletteProjectItems, CommandPaletteThemeItems).
// No signals here: the store feeds in plain data and gets groups of items back.

import type { ThreadStatusPill } from "../sidebar/threadStatus";
import { trimmedSyntaxSegments, type LineSegment, type MatchRange } from "./highlightedSearchLine";

export const RECENT_THREAD_LIMIT = 12;
export const PALETTE_THREAD_LIMIT = 20;
export const PALETTE_SECONDARY_LIMIT = 3;

export type PaletteMode =
  | "root" | "new-thread-in" | "add-project-environment" | "add-project" | "add-project-browse" | "new-project" | "clone" | "appearance" | "theme" | "files" | "content";
export type Appearance = "system" | "light" | "dark";

export type PaletteAction =
  | { kind: "new-thread"; projectId: string | null }
  | { kind: "submenu"; mode: PaletteMode }
  | { kind: "add-project" }
  /** The environment chooser of Add project (several environments can take a project): continue with that one. */
  | { kind: "add-environment"; id: string | null }
  | { kind: "settings"; path?: string }
  | { kind: "usage" }
  | { kind: "pull-requests" }
  | { kind: "open-thread"; id: string; /** A message hit: open find on the query at that message (openThreadFindOnQuery). */ find?: { snippet: string; messageId: string | null; query: string } }
  | { kind: "open-project"; id: string }
  | { kind: "pin-project"; id: string; pinned: boolean }
  | { kind: "appearance"; value: Appearance }
  | { kind: "theme"; id: string; modes: ("light" | "dark")[] }
  | { kind: "open-file"; path: string; line?: number }
  /** Runs a registry command id (commands/registry.ts) and closes the palette. */
  | { kind: "command"; id: string }
  | { kind: "copy"; text: string; notice: string; description?: string; failureTitle?: string }
  | { kind: "restart-session"; threadId: string }
  | { kind: "triage" }
  | { kind: "link-pull-request"; threadId: string }
  | { kind: "show-pull-requests"; threadId: string }
  | { kind: "theme-editor" }
  | { kind: "share-guest"; threadId: string }
  | { kind: "mcp" }
  | { kind: "create-project"; name: string }
  /** The Sources list of Add project: enter that source's next step. */
  | { kind: "add-source"; source: string }
  /** A source that is not set up: the row cannot run, its badge opens Source control settings. */
  | { kind: "setup-required" }
  | { kind: "browse-up" }
  | { kind: "browse-into"; name: string }
  | { kind: "toggle-publish" }
  | { kind: "existing-project" };

export interface PaletteItem {
  value: string;
  group: string;
  title: string;
  /** A content match's line split at its matchRanges (HighlightedSearchLine); matches get the highlight. */
  titleSegments?: LineSegment[];
  /** Text rendered semibold after `title`, as "New thread in <b>project</b>". */
  titleStrong?: string;
  description?: string;
  /** File stem under components/palette/icons or t3ui/icons. */
  icon: string;
  shortcut?: string;
  /** Right-aligned muted text: the relative time, or "Current". */
  trailing?: string;
  /** A thread row's leading status (ThreadRowLeadingStatus): a dot before the title, pulsing while Working or Connecting. */
  leadingStatus?: ThreadStatusPill;
  submenu?: boolean;
  /** Shown but not runnable (a row the reference greys out). */
  disabled?: boolean;
  /** Warning-outline "Setup Required" badge at the right; pressing it opens Source control settings. */
  setupRequired?: { hint: string };
  /** A checkbox at the right (and the host's name when more than one host could take it). */
  toggle?: { checked: boolean; host?: string | undefined; /** The hosts the repository could go to, with the chosen one (a dropdown on the row). */ hosts?: { kind: string; label: string; icon: string }[]; hostKind?: string };
  /** Theme preview circles painted after the title (ThemePreviewCircle, size-3). */
  swatches?: { mode: "light" | "dark"; canvas: string; accent: string; messageAction: string }[];
  searchTerms: string[];
  secondary?: boolean;
  action: PaletteAction;
}

export interface PaletteGroup {
  value: string;
  label: string;
  items: PaletteItem[];
}

export interface PaletteProject {
  id: string;
  name: string;
  path?: string;
  pinned?: boolean;
  updatedAt?: number;
}

export interface PaletteThread {
  id: string;
  projectId: string;
  title: string;
  status: string;
  updatedAt: number;
  latestUserMessageAt?: number;
  createdAt?: number;
  /** The thread's leading status pill, resolved by the caller from the thread's shell (sidebar/threadStatus.ts). */
  statusPill?: ThreadStatusPill | null;
  /** The pull requests linked to the thread (relations.pullRequests), which thread search matches by number, title and link. */
  relations?: { pullRequests?: PaletteThreadPullRequest[] };
}

export interface PaletteThreadPullRequest {
  number: number;
  repository: string;
  url: string;
  /** "stack-dismissed" links are tombstones and are not searched. */
  source?: string;
  snapshot?: { title?: string } | null;
}

/** The threads a pull request page opened the palette on (commandPaletteBus: `linkedThreads`). */
export interface PaletteLinkedThreads {
  /** The query the palette opened with; the rows show only while the field still holds exactly this. */
  query: string;
  environmentId: string;
  threads: { id: string; title: string; archivedAt: string | null }[];
}

export interface PaletteInput {
  mode: PaletteMode;
  query: string;
  projects: PaletteProject[];
  threads: PaletteThread[];
  currentThreadId: string | null;
  currentProjectId: string | null;
  connected: boolean;
  /** projectOrganizationSupported: Pin project is offered only when the server can pin. */
  canPin: boolean;
  appearance: Appearance;
  /** Theme cards and the id applied to the resolved mode (light or dark). */
  themes?: { id: string; label: string; previews: { mode: "light" | "dark"; colors: { canvas: string; accent: string; messageAction: string } }[] }[];
  currentThemeId?: string;
  settings: { id: string; title: string; section: string; path: string }[];
  now: number;
  /** The open thread's workspace: the child searches look in it (the rows are listed without one, as the web does). */
  workspace?: { cwd: string; name: string } | null;
  /** Resolved shortcut badges by command id, with the user's overrides (see paletteModel). Falls back to the defaults. */
  shortcuts?: Record<string, string>;
  /** What the open thread allows; every flag is false without a server thread. */
  thread?: {
    /** chat.find has a handler. */
    canFind: boolean;
    /** composerPromptLink without and with the repository and model. */
    promptLink: string | null;
    promptLinkWithContext: string | null;
    /** The server can link pull requests (capabilities loaded). */
    canLinkPullRequest: boolean;
    /** Linked pull requests the thread has; null when not known. */
    linkedPullRequests: number | null;
    /** Copy thread: the hosted link and what it names. */
    reference: { text: string; description: string; notice: string; /** A pull request link, offered as "Copy PR link" in place of "Copy thread". */ kind?: "pull-request" } | null;
    serverThread: boolean;
    /** Guest links are on for this environment (canShareWithGuest). */
    canShareWithGuest?: boolean;
  };
  /** Set while the palette was opened from a pull request's "Linked from N threads". */
  linkedThreads?: PaletteLinkedThreads | null;
  /** server.prepareTriage is available on the connected environment. */
  canTriage?: boolean;
  /** An environment can create a project (New project). */
  canCreateProject?: boolean;
  /** The connected server has answered its config (Open pull requests is offered). */
  serverConfigLoaded?: boolean;
  /** Server answers for the child searches and message search (palette/paletteSearch.ts). */
  files?: { path: string }[];
  contentMatches?: { path: string; lineNumber: number; lineContent: string; matchRanges?: MatchRange[] }[];
  messageMatches?: { threadId: string; source: string; snippet: string; messageCreatedAt?: string | null; messageId?: string | null }[];
}

// ---- Shortcut labels ----

/** The default keybindings the palette shows a badge for (packages/shared keybindings.ts). */
export const PALETTE_SHORTCUTS: Record<string, string> = {
  "chat.newLocal": "mod+shift+n",
  "chat.newWithoutProject": "mod+alt+n",
  "usage.open": "mod+u",
  "theme.select": "mod+alt+a",
  "appearance.cycle": "mod+alt+shift+a",
  "commandPalette.toggle": "mod+k",
  "sidebar.toggle": "mod+b",
  "filePicker.toggle": "mod+p",
  "projectSearch.toggle": "mod+shift+f",
  "chat.find": "mod+f",
  "thread.copyReference": "mod+shift+c",
  "themeEditor.toggle": "mod+alt+shift+t",
  "workspace.focusNext": "f6",
  "workspace.focusPrevious": "shift+f6",
};

/** formatShortcutLabel on macOS: control, option, shift, command, then the key. */
export function formatShortcut(shortcut: string): string {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1));
  const keyLabel = key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1);
  return `${mods.has("ctrl") ? "⌃" : ""}${mods.has("alt") ? "⌥" : ""}${mods.has("shift") ? "⇧" : ""}${mods.has("mod") || mods.has("meta") ? "⌘" : ""}${keyLabel}`;
}

export function shortcutFor(command: string): string | undefined {
  const shortcut = PALETTE_SHORTCUTS[command];
  return shortcut ? formatShortcut(shortcut) : undefined;
}

/** The badge for a command: the resolved binding when the model supplied them, else the default. */
function badge(input: Pick<PaletteInput, "shortcuts">, command: string): string | undefined {
  return input.shortcuts ? input.shortcuts[command] : shortcutFor(command);
}

// ---- Relative time (timestampFormat.formatRelativeTimeLabel) ----

export function formatRelativeTimeLabel(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "";
  const seconds = Math.floor(Math.max(0, now - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---- Matching ----

function fold(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** 0 best. Title prefix, then word start, then substring, then search terms. null is no match. */
export function scoreItem(item: Pick<PaletteItem, "title" | "titleStrong" | "searchTerms" | "description">, query: string): number | null {
  const needle = fold(query.trim());
  if (!needle) return 0;
  const title = fold(`${item.title}${item.titleStrong ?? ""}`);
  if (title.startsWith(needle)) return 0;
  if (title.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle))) return 1;
  if (title.includes(needle)) return 2;
  if (item.searchTerms.some((term) => fold(term).includes(needle))) return 3;
  if (item.description && fold(item.description).includes(needle)) return 4;
  return null;
}

export function filterItems<T extends Pick<PaletteItem, "title" | "titleStrong" | "searchTerms" | "description" | "secondary">>(items: T[], query: string): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = scoreItem(item, query);
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) =>
    Number(a.item.secondary ?? false) - Number(b.item.secondary ?? false) || a.score - b.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}

// ---- Item builders ----

export function placeholderFor(mode: PaletteMode, workspaceName?: string): string {
  if (mode === "new-project") return "Project name";
  if (mode === "add-project-browse") return "Enter path (e.g. ~/projects/my-app)";
  if (mode === "files") return "Search files…";
  if (mode === "content") return `Search in ${workspaceName ?? "project"}`;
  return mode === "root" ? "Search commands, projects, and threads..." : "Search...";
}

/** useFilesystemReadAccess for content search: checking while the session has not answered, denied without filesystem:read. */
export type FileAccess = "checking" | "granted" | "denied" | "offline";
/** resolveFilesystemReadAccess: an environment that is not connected cannot finish its session check. */
export const CONTENT_SEARCH_OFFLINE = "This environment is not connected.";
export const CONTENT_SEARCH_DENIED = "This connection cannot search host files.";

export function emptyMessage(mode: PaletteMode, query = "", pending = false, fileAccess: FileAccess = "granted"): string {
  if (mode === "content" && fileAccess === "checking") return "Checking file access…";
  if (mode === "content" && fileAccess === "denied") return CONTENT_SEARCH_DENIED;
  if (mode === "content" && fileAccess === "offline") return CONTENT_SEARCH_OFFLINE;
  if (mode === "files") return pending ? (query.trim() ? "Searching workspace files…" : "Indexing workspace files…") : (query.trim() ? "No matching files." : "No files found.");
  if (mode === "content") return pending ? "Searching…" : query.trim() ? "No results found." : "Type to search across your project.";
  return mode === "root" ? "No matching commands, projects, or threads." : "No matching options.";
}

export function splitPath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { name: path, directory: "" } : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}

function fileItems(input: PaletteInput): PaletteItem[] {
  return (input.files ?? []).map((file) => {
    const { name, directory } = splitPath(file.path);
    return {
      value: `file:${file.path}`, group: "files", title: name, ...(directory ? { description: directory } : {}), icon: "file-search",
      searchTerms: [file.path], action: { kind: "open-file", path: file.path },
    } as PaletteItem;
  });
}

function contentItems(input: PaletteInput): PaletteItem[] {
  return (input.contentMatches ?? []).map((match) => ({
    value: `content:${match.path}:${match.lineNumber}`, group: "content", title: match.lineContent.trim() || "(blank line)",
    description: `${match.path}:${match.lineNumber}`, icon: "text-search", searchTerms: [match.lineContent, match.path],
    ...(match.lineContent.trim() ? { titleSegments: trimmedSyntaxSegments(match.lineContent, match.matchRanges, match.path) } : {}),
    action: { kind: "open-file", path: match.path, line: match.lineNumber },
  } as PaletteItem));
}

const APPEARANCE_OPTIONS: { mode: Appearance; label: string; icon: string }[] = [
  { mode: "system", label: "System", icon: "monitor" },
  { mode: "light", label: "Light", icon: "sun" },
  { mode: "dark", label: "Dark", icon: "moon" },
];

function appearanceItems(current: Appearance): PaletteItem[] {
  return APPEARANCE_OPTIONS.map(({ mode, label, icon }) => ({
    value: `appearance:${mode}`,
    group: "appearance",
    title: label,
    icon,
    searchTerms: [label, "appearance", "mode"],
    ...(current === mode ? { trailing: "Current" } : {}),
    action: { kind: "appearance", value: mode },
  }));
}

function themeItems(input: PaletteInput): PaletteItem[] {
  return (input.themes ?? []).map((card) => ({
    value: `theme:palette:${card.id}`,
    group: "themes",
    title: card.label,
    ...(card.previews.length === 1 ? { description: `For ${card.previews[0]!.mode} mode` } : {}),
    icon: "palette",
    searchTerms: [card.label, "theme", "appearance"],
    ...(input.currentThemeId === card.id ? { trailing: "Current" } : {}),
    swatches: card.previews.map((preview) => ({ mode: preview.mode, ...preview.colors })),
    action: { kind: "theme", id: card.id, modes: card.previews.map((preview) => preview.mode) },
  } as PaletteItem));
}

function projectTargetItems(input: PaletteInput): PaletteItem[] {
  const items: PaletteItem[] = input.projects.map((project) => ({
    value: `new-thread-in:${project.id}`,
    group: "new-thread-in",
    title: project.name,
    ...(project.path ? { description: project.path } : {}),
    icon: "folder",
    searchTerms: [project.name, project.path ?? ""],
    ...(input.currentProjectId === project.id ? { trailing: "Current" } : {}),
    action: { kind: "new-thread", projectId: project.id },
  }));
  const noProject: PaletteItem = {
    value: "new-thread-in:none",
    group: "new-thread-in",
    title: "No project",
    icon: "message-square-dashed",
    shortcut: badge(input, "chat.newWithoutProject"),
    searchTerms: ["no project", "without project", "none"],
    action: { kind: "new-thread", projectId: null },
  } as PaletteItem;
  const pinnedCount = input.projects.filter((project) => project.pinned).length;
  items.splice(Math.min(pinnedCount + 1, items.length), 0, noProject);
  return items;
}

export function buildActionItems(input: PaletteInput): PaletteItem[] {
  const items: PaletteItem[] = [];
  const thread = input.thread;
  const contextual = input.projects.find((project) => project.id === input.currentProjectId) ?? input.projects[0];
  if (contextual) {
    items.push({
      value: "action:new-thread",
      group: "actions",
      title: "New thread in ",
      titleStrong: contextual.name,
      icon: "square-pen",
      shortcut: badge(input, "chat.newLocal"),
      searchTerms: ["new thread", "chat", "create", "draft"],
      action: { kind: "new-thread", projectId: contextual.id },
    });
  }
  if (input.projects.length > 0) {
    items.push({
      value: "action:new-thread-in",
      group: "actions",
      title: "New thread in...",
      icon: "square-pen",
      submenu: true,
      searchTerms: ["new thread", "project", "pick", "choose", "select"],
      action: { kind: "submenu", mode: "new-thread-in" },
    });
  }
  items.push({
    value: "action:new-thread-without-project",
    group: "actions",
    title: "New thread without a project",
    icon: "message-square-dashed",
    shortcut: badge(input, "chat.newWithoutProject"),
    searchTerms: ["new thread", "no project", "without project", "none", "chat"],
    action: { kind: "new-thread", projectId: null },
  });
  if (input.canTriage) {
    items.push({
      value: "action:triage",
      group: "actions",
      title: "Triage an issue",
      description: "An agent investigates a R3 Code problem and helps file an issue",
      icon: "bug",
      searchTerms: ["triage", "bug", "issue", "report", "broken", "debug", "help", "support"],
      action: { kind: "triage" },
    });
  }
  if (thread?.serverThread && thread.canFind) {
    items.push({
      value: "find-current-thread",
      group: "actions",
      title: "Find in current thread",
      icon: "text-search",
      shortcut: badge(input, "chat.find"),
      searchTerms: ["find", "search", "messages", "plans"],
      action: { kind: "command", id: "chat.find" },
    });
  }
  if (thread?.promptLink) {
    items.push({
      value: "action:copy-prompt-link",
      group: "actions",
      title: "Copy prompt link",
      icon: "link",
      searchTerms: ["copy", "share", "prompt", "link"],
      action: { kind: "copy", text: thread.promptLink, notice: "Prompt link copied", failureTitle: "Could not copy the prompt link" },
    });
    if (thread.promptLinkWithContext) {
      items.push({
        value: "action:copy-prompt-link-with-context",
        group: "actions",
        title: "Copy prompt link with repo and model",
        icon: "link",
        searchTerms: ["copy", "share", "prompt", "link", "repository", "model"],
        action: { kind: "copy", text: thread.promptLinkWithContext, notice: "Prompt link copied", failureTitle: "Could not copy the prompt link" },
      });
    }
  }
  if (thread?.reference) {
    items.push({
      value: "action:copy-thread-reference",
      group: "actions",
      title: thread.reference.kind === "pull-request" ? "Copy PR link" : "Copy thread",
      description: thread.reference.description,
      icon: "link",
      shortcut: badge(input, "thread.copyReference"),
      searchTerms: thread.reference.kind === "pull-request" ? ["copy", "pull request", "link", "reference"] : ["copy", "thread", "thread id", "reference"],
      action: {
        kind: "copy", text: thread.reference.text, notice: thread.reference.notice, description: thread.reference.description,
        failureTitle: thread.reference.kind === "pull-request" ? "Failed to copy PR link" : "Could not copy thread",
      },
    });
  }
  if (thread?.serverThread && thread.canLinkPullRequest && input.currentThreadId) {
    items.push({
      value: "action:link-pull-request",
      group: "actions",
      title: "Link pull request to thread",
      icon: "link-2",
      searchTerms: ["link", "pull request", "pr", "attach", "stack"],
      action: { kind: "link-pull-request", threadId: input.currentThreadId },
    });
    items.push({
      value: "action:open-thread-pull-requests",
      group: "actions",
      title: "Show linked pull requests",
      icon: "link-2",
      searchTerms: ["pull requests", "linked", "stack", "prs"],
      ...(thread.linkedPullRequests === 0 ? { disabled: true } : {}),
      action: { kind: "show-pull-requests", threadId: input.currentThreadId },
    });
  }
  if (thread?.serverThread && thread.canShareWithGuest && input.currentThreadId) {
    items.push({
      value: "action:share-thread-with-guest",
      group: "actions",
      title: "Share with guest",
      icon: "user-plus",
      searchTerms: ["share", "guest", "invite", "link", "teammate"],
      action: { kind: "share-guest", threadId: input.currentThreadId },
    });
  }
  if (thread?.serverThread && input.currentThreadId) {
    items.push({
      value: "action:restart-agent-session",
      group: "actions",
      title: "Restart agent session",
      icon: "rotate-ccw",
      searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
      action: { kind: "restart-session", threadId: input.currentThreadId },
    });
  }
  {
    items.push({
      value: "action:open-file-picker", group: "actions", title: "Go to file", icon: "file-search", shortcut: badge(input, "filePicker.toggle"),
      searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"], action: { kind: "submenu", mode: "files" },
    });
    items.push({
      value: "action:search-project-contents", group: "actions", title: "Search project contents", icon: "text-search", shortcut: badge(input, "projectSearch.toggle"),
      searchTerms: ["search project", "find in files", "grep", "content search", "text search"], action: { kind: "submenu", mode: "content" },
    });
  }
  if (input.canCreateProject) {
    items.push({
      value: "action:new-project",
      group: "actions",
      title: "New project",
      icon: "folder-git-2",
      searchTerms: ["new project", "create project", "empty", "repository", "repo", "git init"],
      action: { kind: "submenu", mode: "new-project" },
    });
  }
  items.push({
    value: "action:add-project",
    group: "actions",
    title: "Add project",
    icon: "folder-plus",
    searchTerms: [
      "add project", "folder", "directory", "browse", "clone", "remote", "repository", "repo", "git", "github", "gitlab", "bitbucket", "azure", "devops",
      "forgejo", "gitea", "gitcafe", "cursor", "origin", "url", "environment",
    ],
    action: { kind: "submenu", mode: "add-project" },
  });
  if ((input.themes ?? []).length > 0) {
    items.push({
      value: "action:change-theme",
      group: "actions",
      title: "Change theme",
      icon: "palette",
      shortcut: badge(input, "theme.select"),
      submenu: true,
      searchTerms: ["change theme", "appearance", "colors", "palette"],
      action: { kind: "submenu", mode: "theme" },
    });
  }
  items.push({
    value: "action:change-appearance",
    group: "actions",
    title: "Change appearance",
    icon: "monitor",
    shortcut: badge(input, "appearance.cycle"),
    submenu: true,
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    action: { kind: "submenu", mode: "appearance" },
  });
  items.push({
    value: "action:theme-editor",
    group: "actions",
    title: "Toggle theme editor",
    icon: "palette",
    shortcut: badge(input, "themeEditor.toggle"),
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    action: { kind: "theme-editor" },
  });
  if (input.serverConfigLoaded ?? true) {
    items.push({
      value: "action:pull-requests",
      group: "actions",
      title: "Open pull requests",
      icon: "git-pull-request-arrow",
      searchTerms: ["pull requests", "prs", "pr", "pull request", "github", "review", "merge", "branch"],
      action: { kind: "pull-requests" },
    });
  }
  items.push({
    value: "action:use-in-another-app",
    group: "actions",
    title: "Use R3 Code in another app (MCP)",
    icon: "plug",
    searchTerms: ["mcp", "connector", "another app", "poke", "claude", "chatgpt", "grok", "muse", "instinct", "openclaw", "hermes"],
    action: { kind: "mcp" },
  });
  items.push({
    value: "action:usage",
    group: "actions",
    title: "Open usage",
    icon: "chart-no-axes-column",
    shortcut: badge(input, "usage.open"),
    searchTerms: ["usage", "use", "tokens", "cost", "spend", "limits", "stats", "analytics"],
    action: { kind: "usage" },
  });
  for (const direction of [1, -1] as const) {
    const title = direction === 1 ? "Focus Next Workspace Area" : "Focus Previous Workspace Area";
    const command = direction === 1 ? "workspace.focusNext" : "workspace.focusPrevious";
    items.push({
      value: `action:workspace-focus:${direction}`,
      group: "actions",
      title,
      icon: "monitor",
      shortcut: badge(input, command),
      searchTerms: [title, "accessibility", "navigation", "focus", "F6"],
      action: { kind: "command", id: command },
    });
  }
  items.push({
    value: "action:settings",
    group: "actions",
    title: "Open settings",
    icon: "settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    action: { kind: "settings" },
  });
  if (contextual && input.canPin) {
    items.push({
      value: "action:project-pin",
      group: "actions",
      title: contextual.pinned ? "Unpin project" : "Pin project",
      description: contextual.name,
      icon: contextual.pinned ? "pin-off" : "pin",
      searchTerms: ["pin", "unpin", "project", "favorite"],
      action: { kind: "pin-project", id: contextual.id, pinned: !contextual.pinned },
    });
  }
  if (contextual) {
    items.push({
      value: "action:project-settings",
      group: "actions",
      title: "Project settings",
      description: contextual.name,
      icon: "folder",
      searchTerms: ["project", "settings", "name", "icon", "scripts", "model", "workspace", "grouping", "checkout", "remove", "t3.json"],
      action: { kind: "settings", path: "/settings/projects" },
    });
  }
  return items;
}

function threadItem(thread: PaletteThread, input: PaletteInput, group: string): PaletteItem {
  const project = input.projects.find((candidate) => candidate.id === thread.projectId);
  const current = thread.id === input.currentThreadId;
  const subtitle = [project?.name, current ? "Current thread" : undefined].filter(Boolean).join(" · ");
  const time = formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt, input.now);
  return {
    value: `thread:${thread.id}`,
    group,
    title: thread.title || "Untitled thread",
    ...(subtitle ? { description: subtitle } : {}),
    icon: "message-square",
    ...(time ? { trailing: time } : {}),
    ...(thread.statusPill ? { leadingStatus: thread.statusPill } : {}),
    searchTerms: [thread.title, project?.name ?? ""],
    ...(current ? { secondary: true } : {}),
    action: { kind: "open-thread", id: thread.id },
  };
}

function projectItem(project: PaletteProject): PaletteItem {
  return {
    value: `project:${project.id}`,
    group: "projects-search",
    title: project.name,
    ...(project.path ? { description: project.path } : {}),
    icon: "folder",
    searchTerms: [project.name, project.path ?? ""],
    action: { kind: "open-project", id: project.id },
  };
}

/** Every option inside a submenu as one root row, e.g. "Change appearance: Dark". */
export function nestedItems(input: PaletteInput, actions: PaletteItem[]): PaletteItem[] {
  const names = new Set(actions.map((item) => `${item.title}${item.titleStrong ?? ""}`));
  const needle = fold(input.query.trim());
  const out: PaletteItem[] = [];
  const add = (parent: string, children: PaletteItem[]) => {
    const stem = parent.replace(/(\.\.\.|…)$/u, "");
    // A query that only names the submenu wants the submenu row itself.
    if (fold(stem).startsWith(needle)) return;
    const prefix = stem === parent ? `${stem}: ` : `${stem.trimEnd()} `;
    for (const child of children) {
      const title = `${prefix}${child.title}`;
      if (names.has(title)) continue;
      out.push({ ...child, group: "nested-search", title, searchTerms: [title] });
    }
  };
  if (input.projects.length > 0) add("New thread in...", projectTargetItems(input).filter((item) => item.value !== "new-thread-in:none"));
  add("Change theme", themeItems(input));
  add("Change appearance", appearanceItems(input.appearance));
  return out;
}

/**
 * buildLinkedThreadActionItems: one action row per thread linked to the pull request. The query rides along as a search term so
 * the rows survive the palette's own filtering of what the field holds.
 */
export function linkedThreadItems(linked: PaletteLinkedThreads): PaletteItem[] {
  return linked.threads.map((thread) => ({
    value: `thread:${linked.environmentId}:${thread.id}`,
    group: "threads-search",
    title: thread.title || "Untitled thread",
    description: thread.archivedAt === null ? "Linked thread" : "Archived thread",
    icon: "message-square",
    searchTerms: [linked.query, thread.title],
    action: { kind: "open-thread", id: thread.id },
  }));
}

const DIGIT = /\d/;
const notCut = (text: string, end: number) => !DIGIT.test(text[end] ?? "");

/**
 * Whether a thread's linked pull requests match the query (thread search, ThreadSearchSubject.pullRequests): `#N`, `N` and
 * `PR N` by number prefix, the pull request title by words, and `owner/repo#N` or the URL as a whole query only (at least
 * 8 characters; a query with a digit may sit inside the reference but never cut a number short, and a pasted link may go
 * on past it).
 */
export function threadMatchesPullRequest(thread: Pick<PaletteThread, "relations">, query: string): boolean {
  const links = (thread.relations?.pullRequests ?? []).filter((link) => link.source !== "stack-dismissed");
  if (links.length === 0) return false;
  const normalized = fold(query.trim()).replace(/\s+/gu, " ");
  if (!normalized) return false;
  const numeric = normalized.replace(/^(?:pr|pull request|pull)\s*(?=#?\d)/u, "").replace(/^#\s*/u, "");
  if (/^\d+$/u.test(numeric) && links.some((link) => String(link.number).startsWith(numeric))) return true;
  if (normalized.length >= 8) {
    const anywhere = DIGIT.test(normalized);
    const matches = (reference: string) => {
      const folded = reference.toLowerCase();
      const at = folded.indexOf(normalized);
      return anywhere
        ? (at !== -1 && notCut(folded, at + normalized.length)) || (normalized.startsWith(folded) && notCut(normalized, folded.length))
        : at === 0;
    };
    if (links.some((link) => matches(`${link.repository}#${link.number}`) || matches(link.url))) return true;
  }
  return false;
}

export function buildPaletteGroups(input: PaletteInput): PaletteGroup[] {
  const query = input.query.trim();
  if (input.mode === "new-thread-in") {
    return [{ value: "new-thread-in", label: "Projects", items: filterItems(projectTargetItems(input), query) }]
      .filter((group) => group.items.length > 0);
  }
  if (input.mode === "files") {
    return [{ value: "files", label: "Files", items: fileItems(input) }].filter((group) => group.items.length > 0);
  }
  if (input.mode === "content") {
    return [{ value: "content", label: "", items: contentItems(input) }].filter((group) => group.items.length > 0);
  }
  if (input.mode === "theme") {
    return [{ value: "themes", label: "Change theme", items: filterItems(themeItems(input), query) }]
      .filter((group) => group.items.length > 0);
  }
  if (input.mode === "appearance") {
    return [{ value: "appearance", label: "Change appearance", items: filterItems(appearanceItems(input.appearance), query) }]
      .filter((group) => group.items.length > 0);
  }
  if (input.mode === "new-project") {
    const name = query;
    const items: PaletteItem[] = [];
    if (name) {
      items.push({
        value: "new-project:create", group: "", title: "Create ", titleStrong: name, icon: "folder-git-2",
        description: "Creates an empty git repository", searchTerms: [name], action: { kind: "create-project", name },
      });
    }
    items.push({
      value: "new-project:existing", group: "", title: "Add existing project", description: "Open a folder or clone a repository",
      icon: "folder-plus", submenu: true, searchTerms: [], action: { kind: "add-project" },
    });
    return [{ value: "new-project", label: "", items }];
  }
  if (input.mode === "add-project") {
    const items: PaletteItem[] = [{
      value: "action:add-project:connect-environment",
      group: "",
      title: "Connect an environment",
      description: "No connected environment can add a project",
      icon: "settings",
      searchTerms: ["connect", "environment"],
      action: { kind: "settings", path: "/settings/connections" },
    }];
    return [{ value: "add-project", label: "", items: filterItems(items, query) }].filter((group) => group.items.length > 0);
  }

  const actions = buildActionItems(input);
  const threads = [...input.threads].sort((a, b) =>
    (b.latestUserMessageAt ?? b.updatedAt) - (a.latestUserMessageAt ?? a.updatedAt));
  if (!query) {
    const groups: PaletteGroup[] = [{ value: "actions", label: "Actions", items: actions }];
    const recent = threads.slice(0, RECENT_THREAD_LIMIT).map((thread) => threadItem(thread, input, "recent-threads"));
    if (recent.length > 0) groups.push({ value: "recent-threads", label: "Recent Threads", items: recent });
    return groups;
  }

  const groups: PaletteGroup[] = [];
  const add = (value: string, label: string, items: PaletteItem[]) => {
    if (items.length > 0) groups.push({ value, label, items });
  };
  const matchedActions = filterItems(actions, query);
  add("actions", "Actions", matchedActions);
  const linkedActive = input.linkedThreads && input.linkedThreads.query === input.query ? input.linkedThreads : null;
  const threadRows = linkedActive ? linkedThreadItems(linkedActive) : threads.map((thread) => threadItem(thread, input, "threads-search"));
  let threadMatches = filterItems(threadRows, query);
  if (!linkedActive) {
    // Threads whose linked pull requests match (#N, N, owner/repo#N, the URL) join the title matches; a query that names a
    // pull request puts them first.
    const listedThreads = new Set(threadMatches.map((item) => item.value));
    const byPullRequest = threads
      .filter((thread) => !listedThreads.has(`thread:${thread.id}`) && threadMatchesPullRequest(thread, query))
      .map((thread) => threadItem(thread, input, "threads-search"));
    const namesPullRequest = /^(?:pr|pull(?: request)?)?\s*#/iu.test(query) || query.includes("/") || query.includes("://");
    threadMatches = namesPullRequest ? [...byPullRequest, ...threadMatches] : [...threadMatches, ...byPullRequest];
  }
  const nested = filterItems(nestedItems(input, actions), query).slice(0, threadMatches.length > 0 ? PALETTE_SECONDARY_LIMIT : undefined);
  add("nested-search", "Suggestions", nested);
  add("threads-search", "Threads", threadMatches.slice(0, PALETTE_THREAD_LIMIT));
  add("projects-search", "Projects", filterItems(input.projects.map(projectItem), query));
  add("settings-search", "Settings", filterItems(input.settings.map((setting): PaletteItem => ({
    value: `setting:${setting.id}`,
    group: "settings-search",
    title: setting.title,
    description: `Settings · ${setting.section}`,
    icon: "settings",
    searchTerms: [setting.title, setting.section],
    action: { kind: "settings", path: setting.path },
  })), query).slice(0, 8));
  const listed = new Set(groups.flatMap((group) => group.items.map((item) => item.value)));
  const messages = (linkedActive ? [] : input.messageMatches ?? []).flatMap((match): PaletteItem[] => {
    const thread = input.threads.find((candidate) => candidate.id === match.threadId);
    const value = `thread:${thread?.id ?? match.threadId}`;
    if (!thread || listed.has(value)) return [];
    const project = input.projects.find((candidate) => candidate.id === thread.projectId);
    const time = formatRelativeTimeLabel(match.messageCreatedAt ? Date.parse(match.messageCreatedAt) : undefined, input.now);
    listed.add(value);
    return [{
      value, group: "threads-messages", title: thread.title || "Untitled thread", description: match.snippet.replace(/\s+/gu, " ").trim(),
      icon: "message-square", ...(time ? { trailing: time } : project ? { trailing: project.name } : {}), searchTerms: [thread.title],
      action: { kind: "open-thread", id: thread.id, find: { snippet: match.snippet, messageId: match.messageId ?? null, query: input.query } },
    }];
  }).slice(0, 8);
  if (messages.length > 0) groups.push({ value: "threads-messages", label: "In messages", items: messages });
  return groups;
}

export function flattenGroups(groups: PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((group) => group.items);
}

// ---- Layout (rows have fixed heights so the active row can be scrolled into view) ----

export const PALETTE_PADDING = 8;
export const PALETTE_HEADING_HEIGHT = 28;
// CommandItem: py-1.5 around a text-sm line (20) is 32; a text-xs description line (16) makes it 48.
export const PALETTE_ROW_HEIGHT = 32;
export const PALETTE_ROW_HEIGHT_WITH_DESCRIPTION = 48;

export function rowHeight(item: Pick<PaletteItem, "description">): number {
  return item.description ? PALETTE_ROW_HEIGHT_WITH_DESCRIPTION : PALETTE_ROW_HEIGHT;
}

/** Top and height of every item, in flat order, inside the scroll content. */
export function itemOffsets(groups: PaletteGroup[]): { top: number; height: number }[] {
  const out: { top: number; height: number }[] = [];
  let y = PALETTE_PADDING;
  for (const group of groups) {
    if (group.label) y += PALETTE_HEADING_HEIGHT;
    for (const item of group.items) {
      const height = rowHeight(item);
      out.push({ top: y, height });
      y += height;
    }
  }
  return out;
}

/** The scroll offset that keeps [top, top+height] inside the viewport, or null when it already is. */
export function scrollOffsetToReveal(
  target: { top: number; height: number },
  offset: number,
  viewport: number,
  margin = 8,
): number | null {
  if (target.top - margin < offset) return Math.max(0, target.top - margin);
  if (target.top + target.height + margin > offset + viewport) return target.top + target.height + margin - viewport;
  return null;
}
