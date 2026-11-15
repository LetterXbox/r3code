// The review guide payload (packages/contracts pullRequestReviewGuide.ts) and what the Guide tab
// derives from it: stale after a push, the failure for the current head, lettered notes per stop.
export interface GuideStop {
  title: string;
  summary: string;
  attention: { kind: string; note: string } | null;
  excerpts: { path: string; side: string; start: number; end: number; caption: string }[];
  files: { path: string; note: string }[];
  notes: { path: string; line: number; title: string; body: string }[];
  questions: string[];
}

export interface GuideRun { tag: "Running" | "Failed"; headSha: string; detail: string; failedAt?: string }

export interface GuideResult {
  guide: { headSha: string; generatedAt: string; stops: GuideStop[] } | null;
  run: GuideRun | null;
  currentHeadSha: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function parseGuideResult(value: unknown): GuideResult {
  if (!record(value)) throw new Error("The server returned an invalid review guide.");
  const guide = record(value.guide)
    ? {
      headSha: text(value.guide.headSha), generatedAt: text(value.guide.generatedAt),
      stops: list(value.guide.stops).flatMap((stop): GuideStop[] => {
        if (!record(stop) || !text(stop.title)) return [];
        return [{
          title: text(stop.title), summary: text(stop.summary),
          attention: record(stop.attention) ? { kind: text(stop.attention.kind), note: text(stop.attention.note) } : null,
          excerpts: list(stop.excerpts).flatMap((e) => (record(e) && text(e.path) ? [{ path: text(e.path), side: text(e.side), start: Number(e.start) || 0, end: Number(e.end) || 0, caption: text(e.caption) }] : [])),
          files: list(stop.files).flatMap((f) => (record(f) && text(f.path) ? [{ path: text(f.path), note: text(f.note) }] : [])),
          notes: list(stop.notes).flatMap((n) => (record(n) && text(n.path) ? [{ path: text(n.path), line: Number(n.line) || 0, title: text(n.title), body: text(n.body) }] : [])),
          questions: list(stop.questions).filter((q): q is string => typeof q === "string"),
        }];
      }),
    }
    : null;
  const run = record(value.run) && (value.run._tag === "Running" || value.run._tag === "Failed")
    ? { tag: value.run._tag, headSha: text(value.run.headSha), detail: text(value.run.detail), ...(typeof value.run.failedAt === "string" ? { failedAt: value.run.failedAt } : {}) } as GuideRun
    : null;
  return { guide, run, currentHeadSha: typeof value.currentHeadSha === "string" ? value.currentHeadSha : null };
}

export const GUIDE_ATTENTION_LABEL: Record<string, string> = {
  tradeoff: "A tradeoff to weigh",
  contract: "A contract to check",
  product: "A product call",
  risk: "A risk to judge",
  accessibility: "An accessibility call",
};

export const GUIDE_FAILURE_HINT = "Check the review guide model in Settings → Source control.";

export function guideIsStale(result: GuideResult): boolean {
  return result.guide !== null && result.currentHeadSha !== null && result.currentHeadSha !== result.guide.headSha;
}

/** A failure only counts for the head the guide would be written for. */
export function guideFailure(result: GuideResult): string | null {
  return result.run?.tag === "Failed" && result.run.headSha === result.currentHeadSha ? result.run.detail : null;
}

export const guideRunning = (result: GuideResult) => result.run?.tag === "Running";

export function guideStepIndex(index: number, delta: 1 | -1, count: number): number {
  return Math.max(0, Math.min(count - 1, index + delta));
}

/** The server's reviewGuidesEnabled setting gates the tab. */
export function guidesEnabled(settings: unknown): boolean {
  return record(settings) && settings.reviewGuidesEnabled === true;
}

// ---- The tour (client-runtime reviewGuideTour.ts) ----

export function stopFilePaths(stop: Pick<GuideStop, "excerpts" | "files">): string[] {
  return [...new Set([...stop.excerpts.map((excerpt) => excerpt.path), ...stop.files.map((file) => file.path)])];
}

export function stopSubline(stop: Pick<GuideStop, "excerpts" | "files">): string {
  const count = stopFilePaths(stop).length;
  if (count === 0) return "Context, no code";
  return count === 1 ? "1 file" : `${count} files`;
}

export function noteMarker(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export interface ExcerptNoteLine { line: number; markers: { marker: string; title: string }[] }

/** The stop's notes with their letters, and for each excerpt the lines that carry a note's marker. */
export function letterStopNotes(stop: Pick<GuideStop, "notes" | "excerpts">) {
  const lettered = stop.notes.map((note, index) => ({ marker: noteMarker(index), note }));
  const byExcerpt = stop.excerpts.map((excerpt): ExcerptNoteLine[] => {
    const lines = new Map<number, { marker: string; title: string }[]>();
    for (const { marker, note } of lettered) {
      if (note.path !== excerpt.path || note.line < excerpt.start || note.line > excerpt.end) continue;
      lines.set(note.line, [...(lines.get(note.line) ?? []), { marker, title: note.title }]);
    }
    return [...lines].map(([line, markers]) => ({ line, markers }));
  });
  return { lettered, byExcerpt };
}

export const GUIDE_RAIL_MIN_WIDTH = 896;
export const GUIDE_NOTES_ASIDE_MIN_WIDTH = 1440;
