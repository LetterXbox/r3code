// The T3 MCP tools' labels and icons, ported from packages/shared t3McpToolPresentation.ts and
// client-runtime work-log/presentation.ts (resolveT3McpToolPresentation): a call to one of the app's own
// MCP tools reads "Linking a pull request" while it runs and "Linked a pull request" once done.
export type T3McpIcon = "t3-code" | "browser" | "device" | "pull-request";
export type T3McpDefinition = { labels: readonly [action: string, running: string, completed: string, detail: string]; icon: T3McpIcon; summaryAction: string; displayName: string };

// [tool, action, running, completed, detail, summary action, icon, display name]
const ROWS: ReadonlyArray<readonly [string, string, string, string, string, string, T3McpIcon, string?]> = [
  ["link_pull_request", "Link", "Linking", "Linked", "a pull request", "link-pr", "pull-request"],
  ["link_pull_requests", "Link", "Linking", "Linked", "pull requests", "link-pr", "pull-request"],
  ["unlink_pull_request", "Unlink", "Unlinking", "Unlinked", "a pull request", "unlink-pr", "pull-request"],
  ["unlink_pull_requests", "Unlink", "Unlinking", "Unlinked", "pull requests by state", "unlink-pr", "pull-request"],
  ["list_thread_pull_requests", "Check", "Checking", "Checked", "linked pull requests", "list-prs", "pull-request"],
  ["watch_pull_request", "Watch", "Watching", "Watching", "a pull request", "watch-pr", "pull-request"],
  ["unwatch_pull_request", "Stop watching", "Unwatching", "Stopped watching", "a pull request", "unwatch-pr", "pull-request"],
  ["write_pull_request_guides", "Write", "Writing", "Started writing", "review guides", "write-pr-guides", "pull-request"],
  ["read_pull_request_guide", "Read", "Reading", "Read", "a review guide", "read-pr-guide", "pull-request"],
  ["orchestrator_capabilities", "Get", "Getting", "Got", "orchestration capabilities", "capabilities", "t3-code"],
  ["delegate_task", "Delegate", "Delegating", "Delegated", "a child task", "delegate", "t3-code"],
  ["task_status", "Get", "Getting", "Got", "delegated task status", "task-status", "t3-code"],
  ["task_cancel", "Cancel", "Canceling", "Requested cancellation of", "a delegated task", "task-cancel", "t3-code"],
  ["schedule_task", "Schedule", "Scheduling", "Scheduled", "a task", "schedule-create", "t3-code"],
  ["list_scheduled_tasks", "List", "Listing", "Listed", "scheduled tasks", "schedule-list", "t3-code"],
  ["update_scheduled_task", "Update", "Updating", "Updated", "a scheduled task", "schedule-update", "t3-code"],
  ["delete_scheduled_task", "Delete", "Deleting", "Requested deletion of", "a scheduled task", "schedule-delete", "t3-code"],
  ["request_secret", "Ask for", "Asking for", "Asked for", "a secret", "secret-request", "t3-code"],
  ["create_threads", "Create", "Creating", "Created", "T3 threads", "thread-create", "t3-code"],
  ["t3_thread_start", "Start", "Starting", "Started", "a T3 thread", "thread-create", "t3-code"],
  ["t3_thread_list", "List", "Listing", "Listed", "T3 threads", "thread-list", "t3-code"],
  ["t3_thread_read", "Read", "Reading", "Read", "a T3 thread", "thread-read", "t3-code"],
  ["t3_thread_send", "Send", "Sending", "Sent", "to a T3 thread", "thread-send", "t3-code"],
  ["t3_thread_wait", "Wait", "Waiting", "Waited", "for a T3 thread", "thread-wait", "t3-code"],
  ["t3_workflow_stop", "Stop", "Stopping", "Requested a stop for", "a workflow", "workflow-stop", "t3-code"],
  ["t3_background_wait", "Update", "Updating", "Updated", "background waits", "background-wait", "t3-code"],
  ["t3_thread_interrupt", "Interrupt", "Interrupting", "Requested an interrupt of", "a T3 thread", "thread-interrupt", "t3-code"],
  ["t3_worktree_handoff", "Hand off", "Handing off", "Handed off", "thread to a git worktree", "worktree-handoff", "t3-code"],
  ["t3_worktree_status", "Get", "Getting", "Got", "thread worktree status", "worktree-status", "t3-code"],
  ["preview_status", "Get", "Getting", "Got", "preview browser status", "browser", "browser"],
  ["preview_open", "Open", "Opening", "Opened", "a page in the preview browser", "browser", "browser"],
  ["preview_navigate", "Navigate", "Navigating", "Navigated", "the preview browser", "browser", "browser"],
  ["preview_dialog", "Respond", "Responding", "Responded", "to a preview browser dialog", "browser", "browser"],
  ["preview_snapshot", "Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page", "browser", "browser", "Snapshot the preview page"],
  ["preview_act", "Use", "Using", "Used", "the preview browser", "browser", "browser"],
  ["preview_click", "Click", "Clicking", "Clicked", "in the preview browser", "browser", "browser"],
  ["preview_press", "Press", "Pressing", "Pressed", "a key in the preview browser", "browser", "browser"],
  ["preview_type", "Type", "Typing", "Typed", "in the preview browser", "browser", "browser"],
  ["preview_hover", "Hover", "Hovering", "Hovered", "in the preview browser", "browser", "browser"],
  ["preview_select", "Choose", "Choosing", "Chose", "an option in the preview browser", "browser", "browser"],
  ["preview_drag", "Drag", "Dragging", "Dragged", "in the preview browser", "browser", "browser"],
  ["preview_upload", "Upload", "Uploading", "Uploaded", "files to the preview browser", "browser", "browser"],
  ["preview_scroll", "Scroll", "Scrolling", "Scrolled", "the preview browser", "browser", "browser"],
  ["preview_resize", "Resize", "Resizing", "Resized", "the preview browser", "browser", "browser"],
  ["preview_evaluate", "Evaluate", "Evaluating", "Evaluated", "script in the preview browser", "browser", "browser"],
  ["preview_wait_for", "Wait", "Waiting", "Waited", "for the preview page", "browser", "browser"],
  ["preview_set_appearance", "Set", "Setting", "Set", "preview browser appearance", "browser", "browser"],
  ["preview_recording_start", "Start", "Starting", "Started", "recording the preview browser", "browser", "browser"],
  ["preview_recording_stop", "Stop", "Stopping", "Stopped", "recording the preview browser", "browser", "browser"],
  ["device_list", "List", "Listing", "Listed", "simulators and emulators", "device", "device"],
  ["device_open", "Open", "Opening", "Opened", "a device in the Device panel", "device", "device"],
  ["device_screenshot", "Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device", "device", "device"],
  ["device_close", "Close", "Closing", "Closed", "a device", "device", "device"],
  ["run_scheduled_task_now", "Run", "Running", "Requested a run of", "a scheduled task", "schedule-run", "t3-code"],
  ["t3_queue", "Manage", "Managing", "Managed", "queued messages", "queue-edit", "t3-code"],
  ["t3_pending_request", "Handle", "Handling", "Handled", "pending questions", "question-respond", "t3-code"],
  ["t3_queue_list", "List", "Listing", "Listed", "queued messages", "queue-list", "t3-code"],
  ["t3_queue_read", "Read", "Reading", "Read", "a queued message", "queue-read", "t3-code"],
  ["t3_queue_edit", "Edit", "Editing", "Edited", "a queued message", "queue-edit", "t3-code"],
  ["t3_queue_cancel", "Cancel", "Canceling", "Requested cancellation of", "a queued run", "queue-cancel", "t3-code"],
  ["t3_queue_reorder", "Reorder", "Reordering", "Reordered", "a queued run", "queue-reorder", "t3-code"],
  ["t3_queue_promote_to_steer", "Steer with", "Steering with", "Requested steering with", "a queued message", "queue-steer", "t3-code"],
  ["t3_pending_request_list", "List", "Listing", "Listed", "pending questions", "question-list", "t3-code"],
  ["t3_pending_request_read", "Read", "Reading", "Read", "pending questions", "question-read", "t3-code"],
  ["t3_pending_request_respond", "Answer", "Answering", "Answered", "pending questions", "question-respond", "t3-code"],
  ["t3_thread_configuration", "Read", "Reading", "Read", "thread configuration", "thread-configuration", "t3-code"],
  ["t3_thread_configure", "Use", "Using", "Used", "thread model settings", "thread-configure", "t3-code"],
  ["t3_thread_transfer", "Use", "Using", "Used", "thread transfers", "thread-fork", "t3-code"],
  ["t3_thread_fork", "Fork", "Forking", "Requested a fork of", "this thread", "thread-fork", "t3-code"],
  ["t3_thread_merge_back", "Merge", "Merging", "Requested a merge of", "thread context", "thread-merge", "t3-code"],
  ["t3_thread_search", "Search", "Searching", "Searched", "thread content", "thread-search", "t3-code"],
  ["t3_thread_transfers", "Read", "Reading", "Read", "thread transfers", "thread-transfers", "t3-code"],
  ["t3_thread_organize", "Organize", "Organizing", "Organized", "a thread", "thread-organize", "t3-code"],
  ["t3_thread_update", "Update", "Updating", "Updated", "T3 thread metadata", "thread-update", "t3-code"],
  ["t3_worktree_list", "List", "Listing", "Listed", "workspace branches", "worktree-list", "t3-code"],
  ["t3_preview_list", "List", "Listing", "Listed", "preview tabs", "browser", "browser"],
  ["t3_preview_close", "Close", "Closing", "Closed", "a preview tab", "browser", "browser"],
  ["t3_environment_read", "Read", "Reading", "Read", "environment preferences", "environment-read", "t3-code"],
  ["t3_environment_links", "List", "Listing", "Listed", "linked environments", "environment-links", "t3-code"],
  ["t3_environment_link", "Ask to link", "Asking to link", "Asked to link", "an environment", "environment-link", "t3-code"],
  ["t3_environment_unlink", "Forget", "Forgetting", "Forgot", "a linked environment", "environment-unlink", "t3-code"],
  ["t3_environment_preferences_update", "Update", "Updating", "Updated", "environment preferences", "environment-update", "t3-code"],
  ["t3_thread_launch", "Launch", "Launching", "Launched", "a project thread", "thread-create", "t3-code"],
  ["t3_project_list", "List", "Listing", "Listed", "projects", "project-list", "t3-code"],
  ["t3_project_read", "Read", "Reading", "Read", "a project", "project-read", "t3-code"],
  ["t3_project_create", "Register", "Registering", "Registered", "a project", "project-create", "t3-code"],
  ["t3_project_update", "Update", "Updating", "Updated", "a project", "project-update", "t3-code"],
  ["t3_project_delete", "Delete", "Deleting", "Deleted", "a project", "project-delete", "t3-code"],
  ["t3_project_clone", "Clone", "Cloning", "Cloned", "a repository", "project-clone", "t3-code"],
  ["t3_attachment_prepare_upload", "Prepare", "Preparing", "Prepared", "an attachment upload", "attachment-prepare", "t3-code"],
  ["t3_attachment_discard", "Discard", "Discarding", "Discarded", "a pending attachment", "attachment-discard", "t3-code"],
  ["t3_thread_send_attachments", "Send", "Sending", "Sent", "attachments", "attachment-send", "t3-code"],
  ["html_preview", "Preview", "Previewing", "Previewed", "an HTML page", "html-preview", "t3-code"],
  ["html_render", "Render", "Rendering", "Rendered", "an HTML page", "html-render", "t3-code"],
]
const TOOLS: Record<string, T3McpDefinition> = {};
for (const [name, action, running, completed, detail, summaryAction, icon, displayName] of ROWS) {
  TOOLS[name] = { labels: [action, running, completed, detail], icon, summaryAction, displayName: displayName ?? `${action} ${detail}` };
}

// Codex registers "t3-code-direct" for T3 tools kept out of Code Mode.
const SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code", "t3-code-direct", "t3_code_direct"]);
const has = (name: string) => Object.prototype.hasOwnProperty.call(TOOLS, name);

function parseToolName(value: string): string | null {
  const label = value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  const mcp = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcp?.groups) return mcp.groups.server !== undefined && mcp.groups.tool !== undefined && SERVER_ALIASES.has(mcp.groups.server.toLowerCase()) ? mcp.groups.tool : null;
  const namespaced = /^(?<server>t3[-_]code[-_]direct|t3-code|t3_code|t3code)(?:[.:/]|\s*\u00b7\s*)(?<tool>.+)$/i.exec(label);
  if (namespaced?.groups) return namespaced.groups.tool ?? null;
  const prefixed = /^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
  const candidate = prefixed?.groups?.tool ?? label;
  if (has(candidate)) return candidate;
  // OpenCode 2 thread prefixes can contain underscores; take the longest known tool-name suffix.
  if (!/^t3-code-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(TOOLS)) if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  return longest;
}

/** The tool id a call names when it is one of the T3 MCP tools, else null. */
export function t3McpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : parseToolName(toolName);
  return name !== null && has(name) ? name : null;
}

/** Action tools present each call as the single-purpose tool its action replaced. */
const ACTION_TOOLS: Record<string, (action: string) => string | undefined> = {
  preview_act: (action) => `preview_${action}`,
  t3_queue: (action) => `t3_queue_${action}`,
  t3_pending_request: (action) => `t3_pending_request_${action}`,
  t3_thread_transfer: (action) => ({ fork: "t3_thread_fork", merge_back: "t3_thread_merge_back", status: "t3_thread_transfers" } as Record<string, string>)[action],
};

export function t3McpDefinition(toolName: string | null | undefined, input?: unknown): T3McpDefinition | null {
  const name = t3McpToolId(toolName);
  if (name === null) return null;
  const action = input !== null && typeof input === "object" ? (input as Record<string, unknown>).action : undefined;
  const actionTool = typeof action === "string" ? ACTION_TOOLS[name]?.(action) : undefined;
  return actionTool !== undefined && has(actionTool) ? TOOLS[actionTool] : TOOLS[name];
}

/** resolveT3McpToolPresentation: the verb follows the call's state, the object is the tool's detail ("PR #12" for a numbered pull request). */
export function t3McpToolLabel(toolName: string | null | undefined, input: unknown, status: string): string | null {
  const definition = t3McpDefinition(toolName, input);
  if (!definition) return null;
  const [action, running, completed, detail] = definition.labels;
  const verb = status === "inProgress" ? running
    : status === "completed" ? completed
    : status === "failed" ? `Failed to ${action.toLowerCase()}`
    : status === "declined" ? `Declined to ${action.toLowerCase()}`
    : status === "stopped" ? `Stopped ${running.toLowerCase()}`
    : running;
  const pullRequest = ["link-pr", "unlink-pr", "watch-pr", "unwatch-pr"].includes(definition.summaryAction);
  const number = input !== null && typeof input === "object" ? (input as Record<string, unknown>).number : undefined;
  const target = pullRequest && typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? `PR #${number}` : detail;
  return `${verb} ${target}`;
}
