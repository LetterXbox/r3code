// Project scripts as server settings (useProjectScriptSettings.ts, resolveProjectScripts in
// packages/shared/src/projectScripts.ts): a project's scripts come from its override in
// `projectSettingsOverrides`, else the defaults or the project's own, and saving writes the override.
// Pure, so it is tested without an engine.
import type { ProjectScript } from "./projectScripts";

type Dict = Record<string, unknown>;

const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);
const scriptList = (value: unknown): ProjectScript[] | undefined => (Array.isArray(value) ? (value.filter((item) => dict(item) !== null) as ProjectScript[]) : undefined);

/** The scripts the project runs: its override wins; folded settings use the defaults; else the legacy override, the project's own, the defaults. */
export function resolveProjectScripts(settings: Dict | null, project: { id: string; scripts: readonly ProjectScript[] }): readonly ProjectScript[] {
  if (!settings) return project.scripts;
  const defaults = scriptList(settings.defaultProjectScripts) ?? [];
  const override = scriptList(dict(dict(settings.projectSettingsOverrides)?.[project.id])?.defaultProjectScripts);
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded === true) return defaults;
  const legacy = dict(settings.projectScriptOverrides)?.[project.id];
  if (legacy === null) return defaults;
  return scriptList(legacy) ?? (project.scripts.length > 0 ? project.scripts : defaults);
}

/** The `server.updateSettings` patch that saves `scripts` as the project's override; null clears the override. */
export function projectScriptsPatch(settings: Dict | null, projectId: string, scripts: readonly ProjectScript[] | null): Dict {
  const overrides = dict(dict(settings?.projectSettingsOverrides)?.[projectId]) ?? {};
  if (scripts === null) {
    const { defaultProjectScripts: _drop, ...rest } = overrides;
    return { projectSettingsOverrides: { [projectId]: Object.keys(rest).length === 0 ? null : rest } };
  }
  return { projectSettingsOverrides: { [projectId]: { ...overrides, defaultProjectScripts: scripts } } };
}
