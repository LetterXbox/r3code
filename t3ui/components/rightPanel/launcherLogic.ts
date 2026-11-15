// The rows of the right panel's "Open a surface" launcher and its add-surface menu (RightPanelTabs.tsx:
// RightPanelEmptyState, addSurfaceActions), and the keys that drive them. Pure, so the rules are tested without an engine.

export type LauncherId = "browser" | "terminal" | "files" | "diff" | "pull-request" | "pull-requests" | "device" | "side-chat";

export interface LauncherState {
  /** A thread with a workspace: the browser opens. */
  browser: boolean;
  terminal: boolean;
  files: boolean;
  diff: boolean;
  pullRequest: boolean;
  pullRequests: boolean;
  /** A thread is open: devices are offered. */
  device: boolean;
  /** `sideChatsOffered` (ChatView.tsx): the row exists only then. */
  sideChatOffered: boolean;
  /** Why a side chat cannot start now (`sideChatDisabledReason`), or null. */
  sideChatReason: string | null;
}

export interface LauncherRow {
  id: LauncherId;
  label: string;
  icon: string;
  /** The key that opens the row (a letter, matched case-insensitively). */
  shortcut: string;
  available: boolean;
  /** The reason an unavailable row gives in its tooltip. */
  hint: string;
  /**
   * The reference defines a description for Device and Side chat but renders it nowhere
   * (RightPanelTabs.tsx:390, :401), so the row carries it and the view does not draw it.
   */
  description?: string;
}

/** SURFACE_UNAVAILABLE_HINTS: the launcher's tooltips. */
export const SURFACE_UNAVAILABLE_HINTS = {
  browser: "Only available in the desktop app.",
  terminal: "Available when a project is open.",
  files: "Available when a project is open.",
  diff: "Available for Git repositories.",
  pullRequest: "No pull request on this branch yet.",
  pullRequests: "No linked pull requests available.",
  device: "Available from a thread.",
  sideChat: "Available after the first message.",
} as const;

/** SURFACE_DISABLED_REASONS: the add-surface menu's tooltips (different copy from the launcher's). */
export const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the R3 Code desktop app.",
  terminal: "Terminal surfaces are only available from a project thread.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  pullRequests: "No linked pull requests are available for this thread.",
  device: "Devices are only available from a thread.",
  sideChat: "Side chats start after the first message.",
} as const;

export const DEVICE_DESCRIPTION = "Watch an iOS Simulator or Android Emulator.";
export const SIDE_CHAT_DESCRIPTION = "Ask a side question while this thread keeps working.";

/** The rows in the reference's order: Browser, Terminal, Files, Diff, Pull request, Linked pull requests, Device, Side chat (when offered). */
export function launcherRows(state: LauncherState, copy: "launcher" | "menu" = "launcher"): LauncherRow[] {
  const hints = copy === "launcher" ? SURFACE_UNAVAILABLE_HINTS : SURFACE_DISABLED_REASONS;
  const rows: LauncherRow[] = [
    { id: "browser", label: "Browser", icon: "earth", shortcut: "B", available: state.browser, hint: hints.browser },
    { id: "terminal", label: "Terminal", icon: "square-terminal", shortcut: "T", available: state.terminal, hint: hints.terminal },
    { id: "files", label: "Files", icon: "files", shortcut: "F", available: state.files, hint: hints.files },
    { id: "diff", label: "Diff", icon: "file-diff", shortcut: "D", available: state.diff, hint: hints.diff },
    { id: "pull-request", label: "Pull request", icon: "git-pull-request-arrow", shortcut: "P", available: state.pullRequest, hint: hints.pullRequest },
    { id: "pull-requests", label: "Linked pull requests", icon: "link", shortcut: "L", available: state.pullRequests, hint: hints.pullRequests },
    { id: "device", label: "Device", icon: "smartphone", shortcut: "M", available: state.device, hint: hints.device, description: DEVICE_DESCRIPTION },
  ];
  if (state.sideChatOffered) {
    rows.push({
      id: "side-chat", label: "Side chat", icon: "messages-square", shortcut: "S", available: state.sideChatReason === null,
      hint: state.sideChatReason ?? hints.sideChat, description: SIDE_CHAT_DESCRIPTION,
    });
  }
  return rows;
}

/** surfaceShortcutActionForKey: the available row whose letter was pressed; modifiers never match. */
export function rowForKey<Row extends LauncherRow>(rows: readonly Row[], key: string, modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {}): Row | null {
  if (modifiers.meta || modifiers.ctrl || modifiers.alt) return null;
  const typed = key.toLowerCase();
  return rows.find((row) => row.available && row.shortcut.toLowerCase() === typed) ?? null;
}

/**
 * The highlight after an arrow key among the `count` available rows: Down and Right step forward, Up and Left back,
 * both wrapping; Up from nothing lands on the last row. -1 is no highlight.
 */
export function stepHighlight(count: number, current: number, key: "down" | "right" | "up" | "left"): number {
  if (count === 0) return -1;
  const index = Math.min(current, count - 1);
  if (key === "down" || key === "right") return (index + 1) % count;
  return index === -1 ? count - 1 : (index - 1 + count) % count;
}
