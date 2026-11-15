export interface FolderEntry {
  name: string;
  fullPath: string;
}

export interface FolderListing {
  parentPath: string;
  entries: FolderEntry[];
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

export function parseFolderListing(value: unknown): FolderListing {
  const result = record(value);
  if (!result || typeof result.parentPath !== "string" || !result.parentPath.trim() || !Array.isArray(result.entries)) {
    throw new Error("The environment returned an invalid folder listing.");
  }
  const entries: FolderEntry[] = [];
  for (const rawEntry of result.entries) {
    const entry = record(rawEntry);
    if (!entry || typeof entry.name !== "string" || !entry.name.trim() ||
        typeof entry.fullPath !== "string" || !entry.fullPath.trim()) {
      throw new Error("The environment returned an invalid folder listing.");
    }
    entries.push({ name: entry.name, fullPath: entry.fullPath });
  }
  return { parentPath: result.parentPath, entries };
}

export function folderBrowsePath(path: string): string {
  const value = path.trim() || "~/";
  if (/[\\/]$/.test(value)) return value;
  const separator = value.includes("\\") && !value.includes("/") ? "\\" : "/";
  return `${value}${separator}`;
}

export function parentFolder(path: string): string | null {
  if (/^[\\/]+$/.test(path) || /^[a-z]:[\\/]*$/i.test(path)) return null;
  const value = path.replace(/[\\/]+$/, "");
  if (/^\\\\[^\\]+\\[^\\]+$/.test(value)) return null;
  const separatorIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (separatorIndex < 0) return null;
  if (separatorIndex === 0) return value[0];
  const parent = value.slice(0, separatorIndex);
  if (/^[a-z]:$/i.test(parent)) return `${parent}${value[separatorIndex]}`;
  return parent;
}
