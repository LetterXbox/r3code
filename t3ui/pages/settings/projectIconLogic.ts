// ProjectIconPickerDialog.tsx and ProjectFaviconPickerDialog.tsx logic (projectIconOptions.ts, contracts
// ProjectMonogramText): what the pickers offer and what they save.
import { POPULAR_PROJECT_ICONS } from "../../components/sidebar/projectLucideIcons";
import type { ProjectIcon, ProjectIconColor } from "../../components/sidebar/projectIcon";

export const PROJECT_ICON_COLORS: { value: ProjectIconColor; label: string }[] = (
  ["gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"] as ProjectIconColor[]
).map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));

/** projectIconOptions.ts POPULAR_PROJECT_ICONS, the marks bundled with the app (ProjectMark draws any other name as folder-code). */
export const PROJECT_ICON_NAMES = POPULAR_PROJECT_ICONS;
export const DEFAULT_ICON = "folder-code";

export const PROJECT_EMOJIS: { emoji: string; label: string }[] = [
  ["💻", "Computer"], ["🛠️", "Tools"], ["🚀", "Rocket"], ["🤖", "Robot"], ["✨", "Sparkles"], ["⚡", "Lightning"], ["🌐", "Web"], ["📱", "Mobile"],
  ["🖥️", "Desktop"], ["⌨️", "Keyboard"], ["⚙️", "Gear"], ["🗄️", "Database"], ["☁️", "Cloud"], ["📦", "Package"], ["📚", "Books"], ["🧪", "Test tube"],
  ["🔒", "Lock"], ["🎮", "Game"], ["🎵", "Music"], ["🎬", "Movie"], ["🖼️", "Picture"], ["🛍️", "Shopping"], ["🔥", "Fire"], ["💡", "Idea"],
  ["🧩", "Puzzle"], ["📊", "Chart"], ["🧠", "Brain"], ["🦄", "Unicorn"], ["🐙", "Octopus"], ["🌱", "Seedling"],
].map(([emoji, label]) => ({ emoji: emoji!, label: label! }));

/** filterProjectIconNames: the popular set while empty, else the names containing the query (spaces as dashes),
 * capped at 60. The reference searches every Lucide name; only the bundled ones can draw here. */
export function filterIconNames(query: string): string[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, "-");
  return needle ? PROJECT_ICON_NAMES.filter((name) => name.includes(needle)).slice(0, 60) : [...PROJECT_ICON_NAMES];
}

/** The first user-perceived character of `text`: a code point with its variation selectors, skin tones, joiners and keycap or flag partner (the engine has no Intl.Segmenter). */
function firstGrapheme(text: string): string {
  const points = [...text];
  let out = points[0] ?? "";
  let i = 1;
  const isRegional = (point: string | undefined) => point !== undefined && /^\p{Regional_Indicator}$/u.test(point);
  if (isRegional(points[0]) && isRegional(points[1])) return points[0]! + points[1]!;
  while (i < points.length) {
    const point = points[i]!;
    if (/^[\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}\p{M}]$/u.test(point)) { out += point; i += 1; continue; }
    if (point === "\u200D" && points[i + 1]) { out += point + points[i + 1]!; i += 2; continue; }
    break;
  }
  return out;
}

/** firstEmoji: the first grapheme when it is an emoji, flag or keycap. */
export function firstEmoji(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segment = firstGrapheme(trimmed);
  const isFlag = /^\p{Regional_Indicator}{2}$/u.test(segment);
  const isKeycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(segment);
  if (!segment || (!/\p{Extended_Pictographic}/u.test(segment) && !isFlag && !isKeycap)) return null;
  return segment;
}

/** ProjectMonogramText: letters or numbers, with marks, at most 2 graphemes and 32 code units. */
export const normalizeMonogram = (letters: string) => letters.normalize("NFKC").trim().toUpperCase();
function monogramGraphemeCount(text: string): number {
  if (typeof Intl !== "undefined" && typeof (Intl as { Segmenter?: unknown }).Segmenter === "function") {
    const Segmenter = (Intl as { Segmenter: new (locale: undefined, opts: { granularity: string }) => { segment: (s: string) => Iterable<unknown> } }).Segmenter;
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
  }
  // Fallback when Intl.Segmenter is unavailable: count non-mark code points not joined by ZWJ.
  let count = 0;
  let afterZwj = false;
  for (const ch of text) {
    if (ch === "\u200D") { afterZwj = true; continue; }
    if (!afterZwj && !/^[\uFE0F\u20E3\p{M}]$/u.test(ch)) count += 1;
    afterZwj = false;
  }
  return count;
}
export const isValidMonogram = (text: string) =>
  text.length > 0 && text.length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}‌‍]*$/u.test(text) && monogramGraphemeCount(text) <= 2;

export type IconMode = "lucide" | "emoji" | "monogram";

/** What Save icon sends, or null while the draft is not valid. */
export function iconToSave(input: { mode: IconMode; iconName: string; color: ProjectIconColor; letters: string; emoji: string }): ProjectIcon | null {
  if (input.mode === "monogram") { const text = normalizeMonogram(input.letters); return isValidMonogram(text) ? { kind: "monogram", text, color: input.color } : null; }
  if (input.mode === "lucide") return { kind: "lucide", name: input.iconName, color: input.color };
  return { kind: "emoji", emoji: input.emoji };
}

/** The workspace-relative path of a chosen file, or null when it lies outside the project folder. */
export function relativeToWorkspace(cwd: string, path: string): string | null {
  const root = cwd.replace(/\/+$/, "");
  return path.startsWith(`${root}/`) && path.length > root.length + 1 ? path.slice(root.length + 1) : null;
}

export interface ImageEntry { path: string; name: string }

/** The image files a `projects.searchEntries` answer lists. */
export function parseImageEntries(value: unknown): ImageEntry[] {
  const entries = (typeof value === "object" && value !== null ? (value as { entries?: unknown }).entries : null);
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): ImageEntry[] => {
    const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
    if (!item || typeof item.path !== "string" || item.kind === "directory") return [];
    return [{ path: item.path, name: item.path.split("/").pop() ?? item.path }];
  });
}

export function faviconEmptyMessage(query: string, error: string | null, pending: boolean): string {
  if (error) return error;
  if (pending) return query.trim() ? "Searching project files…" : "Indexing project files…";
  return query.trim() ? "No matching image files." : "No image files found.";
}
