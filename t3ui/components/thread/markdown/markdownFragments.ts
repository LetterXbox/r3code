// markdownFragments.ts: `#heading` links in a message scroll to that heading (block start), never navigating; headings get
// GitHub-style slug ids (`user-content-<slug>`, `-1`, `-2` ... for repeats, ids already taken skipped). Lookup strips the
// `user-content-` prefix from both sides, prefers the link's own message, then any heading on screen.
import type { ViewRef } from "nsh";

export const SANITIZED_FRAGMENT_PREFIX = "user-content-";

/** githubHeadingSlug: lowercased, letters / marks / numbers / connectors / spaces / hyphens kept, spaces to hyphens. */
export function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** rehypeHeadingIds: the ids of a message's headings in order (null for a heading with no slug). */
export function headingIds(texts: readonly string[], taken: Iterable<string> = []): (string | null)[] {
  const used = new Set(taken);
  const nextSuffix = new Map<string, number>();
  return texts.map((text) => {
    const slug = githubHeadingSlug(text);
    if (!slug) return null;
    let count = nextSuffix.get(slug) ?? 0;
    let id = `${SANITIZED_FRAGMENT_PREFIX}${slug}`;
    while (used.has(id)) {
      count += 1;
      id = `${SANITIZED_FRAGMENT_PREFIX}${slug}-${count}`;
    }
    nextSuffix.set(slug, count);
    used.add(id);
    return id;
  });
}

/** decodeMarkdownFragmentId: the href's id after `#`, percent-decoded when it decodes. */
export function decodeFragmentId(href: string): string {
  const encoded = href.startsWith("#") ? href.slice(1) : href;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** normalizeSanitizedFragmentId: every leading `user-content-` removed. */
export function normalizeFragmentId(id: string): string {
  let normalized = id;
  while (normalized.startsWith(SANITIZED_FRAGMENT_PREFIX)) normalized = normalized.slice(SANITIZED_FRAGMENT_PREFIX.length);
  return normalized;
}

/** Whether a heading id is the one `href` names. */
export function fragmentMatches(href: string, id: string): boolean {
  const decoded = decodeFragmentId(href);
  return id === decoded || normalizeFragmentId(id) === normalizeFragmentId(decoded);
}

/** The first id of `ids` that `href` names. */
export function findFragmentTarget(href: string, ids: Iterable<string>): string | null {
  for (const id of ids) if (fragmentMatches(href, id)) return id;
  return null;
}

// ---- headings on screen, and the scroll that brings one to the top ----

const mounted = new Map<ViewRef, string>();
let scrollIntoView: ((target: ViewRef) => void) | null = null;

/** A heading's view registered under its id while it is mounted (returns the unregister). */
export function registerHeading(node: ViewRef, id: string): () => void {
  mounted.set(node, id);
  return () => { if (mounted.get(node) === id) mounted.delete(node); };
}

/** The transcript registers how it scrolls a view to its top (scrollIntoView block start). */
export function registerFragmentScroller(scroll: (target: ViewRef) => void): () => void {
  scrollIntoView = scroll;
  return () => { if (scrollIntoView === scroll) scrollIntoView = null; };
}

/** handleMarkdownFragmentClick: scrolls to the heading `href` names, the message's own (`local`) first; true when one was found. */
export function openMarkdownFragment(href: string, local?: ReadonlyMap<string, ViewRef>): boolean {
  let target: ViewRef | undefined;
  if (local) {
    const id = findFragmentTarget(href, local.keys());
    if (id) target = local.get(id);
  }
  if (!target) for (const [node, id] of mounted) if (fragmentMatches(href, id)) { target = node; break; }
  if (!target) return false;
  scrollIntoView?.(target);
  return true;
}
