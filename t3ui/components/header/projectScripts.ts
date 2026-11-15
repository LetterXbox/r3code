// Project scripts, ported from apps/web/src/projectScripts.ts and
// packages/shared/src/projectScripts.ts. Pure rules; the card's row and dialog
// are in ProjectScriptsRow.tsx.

export type ProjectScriptIconId = "play" | "test" | "lint" | "configure" | "build" | "debug";
export const SCRIPT_ICONS: ReadonlyArray<{ id: ProjectScriptIconId; label: string; icon: string }> = [
  { id: "play", label: "Play", icon: "play" },
  { id: "test", label: "Test", icon: "flask-conical" },
  { id: "lint", label: "Lint", icon: "list-checks" },
  { id: "configure", label: "Configure", icon: "wrench" },
  { id: "build", label: "Build", icon: "hammer" },
  { id: "debug", label: "Debug", icon: "bug" },
];

export interface ProjectScript {
  id: string;
  name: string;
  command: string;
  icon: ProjectScriptIconId;
  runOnWorktreeCreate: boolean;
  runOnSettle?: boolean;
  stopOnSettle?: boolean;
  async?: boolean;
  previewUrl?: string;
  autoOpenPreview?: boolean;
}

/** The editor form (projectScriptEditor.tsx NewProjectScriptInput). */
export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIconId;
  runOnWorktreeCreate: boolean;
  /** Only meaningful with runOnWorktreeCreate: saved as `async: false`. */
  waitForSetup: boolean;
  runOnSettle: boolean;
  stopOnSettle: boolean;
  /** `mod+shift+k` style; "" for none. */
  keybinding: string;
  previewUrl: string;
  autoOpenPreview: boolean;
}

export const EMPTY_PROJECT_SCRIPT_INPUT: NewProjectScriptInput = {
  name: "", command: "", icon: "play", runOnWorktreeCreate: false, waitForSetup: false, runOnSettle: false, stopOnSettle: false,
  keybinding: "", previewUrl: "", autoOpenPreview: false,
};

/** editorRequestForScript: the form a saved script opens with. */
export function inputFromScript(script: ProjectScript, keybinding: string | null): NewProjectScriptInput {
  return {
    name: script.name,
    command: script.command,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    waitForSetup: script.runOnWorktreeCreate && script.async === false,
    runOnSettle: script.runOnSettle ?? false,
    stopOnSettle: script.stopOnSettle ?? false,
    keybinding: keybinding ?? "",
    previewUrl: script.previewUrl ?? "",
    autoOpenPreview: script.autoOpenPreview ?? false,
  };
}

/** The switches' enabling rules: waiting needs the worktree-creation run, auto-open needs a preview URL. */
export function scriptFormRules(input: Pick<NewProjectScriptInput, "runOnWorktreeCreate" | "previewUrl">): { waitEnabled: boolean; autoOpenEnabled: boolean } {
  return { waitEnabled: input.runOnWorktreeCreate, autoOpenEnabled: input.previewUrl.trim().length > 0 };
}

/** The URL a run opens in the preview (useChatTerminalActions.runProjectScript): only with auto-open on and a URL set. */
export function scriptPreviewToOpen(script: ProjectScript): string | null {
  return script.autoOpenPreview === true && script.previewUrl ? script.previewUrl : null;
}

/** The `script.<id>.run` keybinding command (commandForProjectScript); null when the id cannot be one. */
export function commandForProjectScript(scriptId: string): string | null {
  return scriptId.length >= 1 && scriptId.length <= 24 && /^[a-z0-9][a-z0-9-]*$/.test(scriptId) ? `script.${scriptId}.run` : null;
}

/** A role (worktree-creation run, settle run) belongs to one script: saving one that claims it releases the others. */
export function releaseClaimedRoles(script: ProjectScript, saved: NewProjectScriptInput): ProjectScript {
  const releaseSetup = saved.runOnWorktreeCreate && script.runOnWorktreeCreate;
  const releaseSettle = saved.runOnSettle && script.runOnSettle === true;
  if (!releaseSetup && !releaseSettle) return script;
  return { ...script, ...(releaseSetup ? { runOnWorktreeCreate: false } : {}), ...(releaseSettle ? { runOnSettle: false } : {}) };
}

const MAX_SCRIPT_ID_LENGTH = 24;

const ICON_IDS: readonly string[] = SCRIPT_ICONS.map((item) => item.id);

/** Reads a project's raw `scripts` array, dropping malformed entries. */
export function readProjectScripts(value: unknown): ProjectScript[] {
  if (!Array.isArray(value)) return [];
  const scripts: ProjectScript[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim() || typeof raw.name !== "string" || !raw.name.trim() || typeof raw.command !== "string" || !raw.command.trim()) continue;
    scripts.push({
      ...(raw as unknown as ProjectScript),
      id: raw.id,
      name: raw.name,
      command: raw.command,
      icon: typeof raw.icon === "string" && ICON_IDS.includes(raw.icon) ? (raw.icon as ProjectScriptIconId) : "play",
      runOnWorktreeCreate: raw.runOnWorktreeCreate === true,
    });
  }
  return scripts;
}

/** primaryProjectScript: the first ordinary script, else one that is not an on-settle hook. */
export function primaryProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate && !script.runOnSettle);
  return regular ?? scripts.find((script) => !script.runOnSettle) ?? null;
}

/** projectScriptMenuLabel: the name, with its automatic roles in brackets. */
export function projectScriptMenuLabel(script: ProjectScript): string {
  const roles = [...(script.runOnWorktreeCreate ? ["setup"] : []), ...(script.runOnSettle ? ["on settle"] : [])];
  return roles.length === 0 ? script.name : `${script.name} (${roles.join(", ")})`;
}

function normalizeScriptId(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "script";
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const base = normalizeScriptId(name);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, MAX_SCRIPT_ID_LENGTH - tail.length).replace(/-+$/g, "")}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function buildProjectScript(id: string, input: NewProjectScriptInput): ProjectScript {
  const previewUrl = input.previewUrl.trim();
  return {
    id,
    name: input.name.trim(),
    command: input.command.trim(),
    icon: input.icon,
    runOnWorktreeCreate: input.runOnWorktreeCreate,
    ...(input.runOnWorktreeCreate && input.waitForSetup ? { async: false } : {}),
    ...(input.runOnSettle ? { runOnSettle: true } : {}),
    ...(input.stopOnSettle ? { stopOnSettle: true } : {}),
    ...(previewUrl.length === 0 ? {} : { previewUrl, autoOpenPreview: input.autoOpenPreview }),
  };
}

/** Why a script cannot be saved, or null. */
export function scriptValidationError(input: NewProjectScriptInput): string | null {
  if (!input.name.trim()) return "Name is required.";
  if (!input.command.trim()) return "Command is required.";
  return null;
}

/** The scripts after saving `input` as a new script or over `scriptId` (the others release roles it claims). */
export function saveScript(scripts: readonly ProjectScript[], scriptId: string | null, input: NewProjectScriptInput): ProjectScript[] {
  if (scriptId === null) {
    return [...scripts.map((script) => releaseClaimedRoles(script, input)), buildProjectScript(nextProjectScriptId(input.name, scripts.map((script) => script.id)), input)];
  }
  return scripts.map((script) => (script.id === scriptId ? buildProjectScript(script.id, input) : releaseClaimedRoles(script, input)));
}

/** The id a save of `input` gives the script (a new one is named from its name). */
export function savedScriptId(scripts: readonly ProjectScript[], scriptId: string | null, input: NewProjectScriptInput): string {
  return scriptId ?? nextProjectScriptId(input.name, scripts.map((script) => script.id));
}

export function deleteScript(scripts: readonly ProjectScript[], scriptId: string): ProjectScript[] {
  return scripts.filter((script) => script.id !== scriptId);
}

/** projectScriptTerminalInput: a leading space keeps the command out of shell history. */
export function projectScriptTerminalInput(command: string): string {
  return ` ${command}\r`;
}
