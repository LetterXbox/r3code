// The project's t3.json (packages/contracts t3ProjectFile.ts, packages/shared t3ProjectFile.ts,
// hooks/useT3ProjectFileScripts.ts): the checked-in scripts the project actions menu offers under "From t3.json".
// Read through `projects.readFile`; a file that is absent, truncated or does not parse offers nothing.
import type { Request } from "./gitRuntime";
import type { NewProjectScriptInput, ProjectScript, ProjectScriptIconId } from "./projectScripts";

export const T3_PROJECT_FILE_NAME = "t3.json";
const MAX_SCRIPTS = 50;
const ICONS: readonly string[] = ["play", "test", "lint", "configure", "build", "debug"];

export interface T3ProjectFileScript {
  name: string;
  command: string;
  icon?: ProjectScriptIconId;
  runOnWorktreeCreate?: boolean;
  runOnSettle?: boolean;
  stopOnSettle?: boolean;
  async?: boolean;
  previewUrl?: string;
  autoOpenPreview?: boolean;
}

/** fromLenientJson: `//` and block comments and trailing commas are allowed (strings are left alone). */
export function parseLenientJson(input: string): unknown {
  let stripped = input.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, text: string | undefined) => (text ? match : " "));
  stripped = stripped.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (match, text: string | undefined, bracket: string | undefined) => (text ? match : (bracket ?? "")));
  return JSON.parse(stripped);
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

/** T3ProjectFileScript: a name and a command, each non-empty after trimming; a wrong-typed optional key fails the file. */
function readScript(value: unknown): T3ProjectFileScript | null {
  const raw = record(value);
  const name = text(raw?.name);
  const command = text(raw?.command);
  if (!raw || !name || !command) return null;
  const script: T3ProjectFileScript = { name, command };
  if (raw.icon !== undefined) { if (typeof raw.icon !== "string" || !ICONS.includes(raw.icon)) return null; script.icon = raw.icon as ProjectScriptIconId; }
  for (const key of ["runOnWorktreeCreate", "runOnSettle", "stopOnSettle", "async", "autoOpenPreview"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") return null;
    script[key] = raw[key] as boolean;
  }
  if (raw.previewUrl !== undefined) { const url = text(raw.previewUrl); if (!url) return null; script.previewUrl = url; }
  return script;
}

/** parseT3ProjectFile's scripts: null when the file does not parse or a script is invalid. */
export function parseT3ProjectScripts(contents: string): T3ProjectFileScript[] | null {
  let file: Record<string, unknown> | null;
  try { file = record(parseLenientJson(contents)); } catch { return null; }
  if (!file) return null;
  if (file.scripts === undefined) return [];
  if (!Array.isArray(file.scripts) || file.scripts.length > MAX_SCRIPTS) return null;
  const scripts: T3ProjectFileScript[] = [];
  for (const item of file.scripts) { const script = readScript(item); if (!script) return null; scripts.push(script); }
  return scripts;
}

/** `projects.readFile` of t3.json at the project root; absent, truncated or invalid files give none. */
export async function readT3ProjectScripts(cwd: string, request: Request): Promise<T3ProjectFileScript[]> {
  const result = record(await request("projects.readFile", { cwd, relativePath: T3_PROJECT_FILE_NAME, allowMissing: true }));
  if (!result || result.exists === false || result.truncated === true || typeof result.contents !== "string") return [];
  return parseT3ProjectScripts(result.contents) ?? [];
}

/** Scripts of the file that the project does not have yet: the same command or the same name (any case) is already there. */
export function importableScripts(fileScripts: readonly T3ProjectFileScript[], scripts: readonly Pick<ProjectScript, "name" | "command">[]): T3ProjectFileScript[] {
  return fileScripts.filter((file) => !scripts.some((script) => script.command === file.command || script.name.toLowerCase() === file.name.toLowerCase()));
}

/** importFileScript's payload. The shortcut is left alone (the reference sends `keybinding: null`). */
export function importInput(file: T3ProjectFileScript): NewProjectScriptInput {
  return {
    name: file.name,
    command: file.command,
    icon: file.icon ?? "play",
    runOnWorktreeCreate: file.runOnWorktreeCreate ?? false,
    waitForSetup: file.runOnWorktreeCreate === true && file.async === false,
    runOnSettle: file.runOnSettle ?? false,
    stopOnSettle: file.stopOnSettle ?? false,
    keybinding: "",
    previewUrl: file.previewUrl ?? "",
    autoOpenPreview: file.previewUrl ? (file.autoOpenPreview ?? false) : false,
  };
}
