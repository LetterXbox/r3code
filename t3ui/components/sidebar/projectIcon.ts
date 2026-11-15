// A project's configured icon, from ProjectFavicon.tsx. A project can carry an override
// (`projectIcon`: a monogram, an emoji or a lucide mark, each with a colour) or lean on its
// favicon: the server finds an image in the workspace and the app fetches it through a signed
// asset URL. With neither, the tile is the monogram the name gives (ProjectMonogram).
import { signal } from "nsh";
import type { Signal } from "nsh";
import { backendConnectionGeneration, backendStatus, backendUrl, requestBackend } from "../../store";
import type { Project } from "../../store";

export type ProjectIconColor =
  | "gray" | "red" | "orange" | "amber" | "yellow" | "lime" | "green" | "emerald" | "teal"
  | "cyan" | "sky" | "blue" | "indigo" | "violet" | "purple" | "fuchsia" | "pink" | "rose";

export type ProjectIcon =
  | { kind: "monogram"; text: string; color: ProjectIconColor }
  | { kind: "emoji"; emoji: string }
  | { kind: "lucide"; name: string; color: ProjectIconColor };

/** text-<color>-600 in light and -400 in dark (projectIconColors.ts). */
const COLORS: Record<ProjectIconColor, readonly [light: string, dark: string]> = {
  gray: ["#4b5563", "#9ca3af"],
  red: ["#dc2626", "#f87171"],
  orange: ["#ea580c", "#fb923c"],
  amber: ["#d97706", "#fbbf24"],
  yellow: ["#ca8a04", "#facc15"],
  lime: ["#65a30d", "#a3e635"],
  green: ["#16a34a", "#4ade80"],
  emerald: ["#059669", "#34d399"],
  teal: ["#0d9488", "#2dd4bf"],
  cyan: ["#0891b2", "#22d3ee"],
  sky: ["#0284c7", "#38bdf8"],
  blue: ["#2563eb", "#60a5fa"],
  indigo: ["#4f46e5", "#818cf8"],
  violet: ["#7c3aed", "#a78bfa"],
  purple: ["#9333ea", "#c084fc"],
  fuchsia: ["#c026d3", "#e879f9"],
  pink: ["#db2777", "#f472b6"],
  rose: ["#e11d48", "#fb7185"],
};

export function projectIconColor(color: ProjectIconColor, scheme: "light" | "dark"): string {
  return COLORS[color][scheme === "light" ? 0 : 1];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

const isColor = (value: unknown): value is ProjectIconColor => typeof value === "string" && value in COLORS;

/**
 * The icon override a project snapshot carries, or null. A newer server may send kinds this
 * app does not know; those (and anything malformed) read as no override. The older shape
 * carried a monogram on a lucide icon; it reads as a monogram.
 */
export function parseProjectIcon(value: unknown): ProjectIcon | null {
  const icon = record(value);
  if (!icon) return null;
  if (icon.kind === "emoji") {
    return typeof icon.emoji === "string" && icon.emoji.trim() ? { kind: "emoji", emoji: icon.emoji } : null;
  }
  if (icon.kind === "monogram") {
    return typeof icon.text === "string" && icon.text.trim() && isColor(icon.color)
      ? { kind: "monogram", text: icon.text, color: icon.color }
      : null;
  }
  if (icon.kind === "lucide") {
    if (!isColor(icon.color)) return null;
    const legacy = typeof icon.monogramText === "string" ? icon.monogramText : typeof icon.monogram === "string" ? icon.monogram : null;
    if (legacy && legacy.trim()) return { kind: "monogram", text: legacy, color: icon.color };
    return typeof icon.name === "string" && icon.name ? { kind: "lucide", name: icon.name, color: icon.color } : null;
  }
  return null;
}

/** The marker the server puts in the URL when the workspace has no favicon (shared/projectFavicon.ts). */
const PROJECT_FAVICON_FALLBACK_MARKER = "project-favicon-missing";

export function isProjectFaviconFallbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const pathname = new URL(url, "https://t3.invalid").pathname;
    return pathname.slice(pathname.lastIndexOf("/") + 1) === PROJECT_FAVICON_FALLBACK_MARKER;
  } catch {
    return false;
  }
}

/** The absolute URL of a signed asset on the environment's HTTP origin; null when it is not one. */
export function assetUrlFor(endpoint: string, relativeUrl: unknown): string | null {
  if (typeof relativeUrl !== "string" || !relativeUrl.startsWith("/api/assets/") || relativeUrl.startsWith("//")) return null;
  try {
    const base = new URL(endpoint);
    if (base.protocol !== "ws:" && base.protocol !== "wss:" && base.protocol !== "http:" && base.protocol !== "https:") return null;
    base.protocol = base.protocol === "wss:" || base.protocol === "https:" ? "https:" : "http:";
    base.pathname = "/";
    base.search = "";
    base.hash = "";
    const target = new URL(relativeUrl, base);
    return target.origin === base.origin && target.pathname.startsWith("/api/assets/") ? target.toString() : null;
  } catch {
    return null;
  }
}

// Signed URLs last a while; the web refreshes them every half hour, so do the same.
const REFRESH_MS = 25 * 60_000;
interface Entry { src: Signal<string | null>; fetchedAt: number; pending: boolean }
const entries = new Map<string, Entry>();

/** The favicon image for a project with no override: null until fetched, or when the workspace has none. */
export function projectFaviconSrc(project: Pick<Project, "path" | "faviconPath"> | undefined): string | null {
  const cwd = project?.path;
  if (!cwd || backendStatus() !== "connected") return null;
  const endpoint = backendUrl();
  const generation = backendConnectionGeneration();
  const key = JSON.stringify([endpoint, generation, cwd, project.faviconPath ?? null]);
  let entry = entries.get(key);
  if (!entry) {
    entry = { src: signal<string | null>(null), fetchedAt: 0, pending: false };
    entries.set(key, entry);
  }
  const current = entry;
  if (!current.pending && Date.now() - current.fetchedAt > REFRESH_MS) {
    current.pending = true;
    const resource = { _tag: "project-favicon", cwd, ...(project.faviconPath ? { path: project.faviconPath } : {}) };
    void requestBackend("assets.createUrl", { resource }).then((response) => {
      const url = assetUrlFor(endpoint, record(response)?.relativeUrl);
      current.src.set(url && !isProjectFaviconFallbackUrl(url) ? url : null);
    }).catch(() => {
      current.src.set(null);
    }).finally(() => {
      current.fetchedAt = Date.now();
      current.pending = false;
    });
  }
  return current.src();
}
