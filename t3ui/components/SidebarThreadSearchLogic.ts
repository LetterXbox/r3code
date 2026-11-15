export interface SidebarMessageMatch {
  threadId: string;
  projectId: string;
  source: "user" | "assistant";
  snippet: string;
  messageId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

export function parseSidebarMessageMatches(value: unknown): SidebarMessageMatch[] {
  const result = record(value);
  if (!result || !Array.isArray(result.matches)) throw new Error("The environment returned invalid search results.");
  return result.matches.map((raw: unknown) => {
    const match = record(raw);
    if (!match || typeof match.threadId !== "string" || !match.threadId.trim() ||
        typeof match.projectId !== "string" || !match.projectId.trim() ||
        (match.source !== "user" && match.source !== "assistant") ||
        typeof match.snippet !== "string" ||
        (match.messageId != null && (typeof match.messageId !== "string" || !match.messageId.trim()))) {
      throw new Error("The environment returned invalid search results.");
    }
    return {
      threadId: match.threadId,
      projectId: match.projectId,
      source: match.source,
      snippet: match.snippet,
      messageId: typeof match.messageId === "string" ? match.messageId : null,
    };
  });
}

/** The highlight follows its thread, so rows that arrive late do not move it under Enter; a new query starts at the top. */
export function activeSearchIndex(keys: readonly string[], highlightKey: string | null): number {
  return Math.max(0, highlightKey === null ? 0 : keys.indexOf(highlightKey));
}

/** Up and Down wrap around the results, as the web's moveSearchHighlight does. */
export function moveSearchHighlight(keys: readonly string[], highlightKey: string | null, step: 1 | -1): string | null {
  const count = keys.length;
  if (count === 0) return null;
  const index = activeSearchIndex(keys, highlightKey);
  return keys[(index + step + count) % count] ?? null;
}
