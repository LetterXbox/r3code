// State, checks and review presentation, ported from pullRequestIcons.tsx and
// pullRequestPresentation.tsx. Tones are the web's dark/light pairs.
export type Scheme = "light" | "dark";

interface Tone { light: string; dark: string }
const EMERALD: Tone = { light: "#059669", dark: "#6ee7b7" };
const ZINC: Tone = { light: "#71717a", dark: "#a1a1aa" };
const RED: Tone = { light: "#dc2626", dark: "#fca5a5" };
const VIOLET: Tone = { light: "#7c3aed", dark: "#c4b5fd" };
const AMBER: Tone = { light: "#d97706", dark: "#fbbf24" };
const DESTRUCTIVE: Tone = { light: "#dc2626", dark: "#f87171" };
const MUTED: Tone = { light: "#a1a1aa", dark: "#71717a" };

export interface Presentation { label: string; icon: string; tone: Tone }

export function toneColor(tone: Tone, scheme: Scheme): string {
  return tone[scheme];
}

export function resolveState(input: { state: string; isDraft: boolean }): Presentation {
  if (input.state === "open" && input.isDraft) return { label: "Draft", icon: "git-pull-request-draft", tone: ZINC };
  if (input.state === "closed") return { label: "Closed", icon: "git-pull-request-closed", tone: RED };
  if (input.state === "merged") return { label: "Merged", icon: "git-merge", tone: VIOLET };
  return { label: "Open", icon: "git-pull-request-arrow", tone: EMERALD };
}

/** The conflict badge at the corner of the state glyph. */
export function resolveConflict(input: { state: string; isDraft: boolean; mergeability: string; baseBranch: string }): Presentation | null {
  if (input.state !== "open" || input.isDraft || input.mergeability !== "conflicting") return null;
  return { label: input.baseBranch ? `Conflicts with ${input.baseBranch}` : "Has conflicts", icon: "triangle-alert", tone: DESTRUCTIVE };
}

export function resolveChecksState(state: string): Presentation | null {
  switch (state) {
    case "passing": return { label: "All checks have passed", icon: "circle-check", tone: EMERALD };
    case "failing": return { label: "Some checks were not successful", icon: "circle-x", tone: DESTRUCTIVE };
    case "pending": return { label: "Some checks haven't completed yet", icon: "circle-dot", tone: AMBER };
    default: return null;
  }
}

export function resolveReviewDecision(decision: string): Presentation | null {
  switch (decision) {
    case "approved": return { label: "Approved", icon: "user-check", tone: EMERALD };
    case "changes-requested": return { label: "Changes requested", icon: "user-round-x", tone: AMBER };
    case "review-required": return { label: "Awaiting review", icon: "user-round", tone: MUTED };
    default: return null;
  }
}

export function pullRequestLabelColor(color: string): string | null {
  const hex = color.trim().replace(/^#/u, "");
  return /^[0-9a-fA-F]{6}$/u.test(hex) ? `#${hex}` : null;
}

/** Relative time as RelativeTime shows it: "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.floor(Math.max(0, now - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/u, "")}k` : String(value);
}
