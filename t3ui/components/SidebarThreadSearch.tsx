import { effect, keymap, signal, Text, View } from "nsh";
import {
  allProjects,
  allThreads,
  backendConnectionGeneration,
  backendStatus,
  backendUrl,
  openThread,
  requestBackend,
  setSidebarThreadQuery,
  sidebarThreadQuery,
  threadById,
} from "../store";
import type { Thread } from "../store";
import { sidebarRelativeTime } from "./SidebarUtils";
import { ProjectTile } from "./sidebar/ProjectTile";
import { activeSearchIndex, moveSearchHighlight, parseSidebarMessageMatches, type SidebarMessageMatch } from "./SidebarThreadSearchLogic";
import { canSearchThreadMessages, findSearchTokenRanges, normalizeThreadSearchQuery, splitSearchText } from "./sidebar/searchHighlight";

/** THREAD_SEARCH_DEBOUNCE_MS (state/queries.ts). */
export const THREAD_SEARCH_DEBOUNCE_MS = 120;

export interface SearchResult {
  thread: Thread;
  match: SidebarMessageMatch | null;
}

export interface SidebarSearchNavigation {
  environment: string;
  generation: number;
  threadId: string;
  match: SidebarMessageMatch;
  query: string;
}

/** A message target is kept until the selected thread's transcript arrives. */
export const sidebarSearchNavigation = signal<SidebarSearchNavigation | null>(null);

export function selectSidebarSearchResult(result: SearchResult, onSelect: (id: string) => void) {
  const environment = backendUrl();
  const generation = backendConnectionGeneration();
  const query = sidebarThreadQuery().trim();
  const target = result.match ? { environment, generation, threadId: result.thread.id, match: result.match, query } : null;
  onSelect(result.thread.id);
  sidebarSearchNavigation.set(target);
}

/**
 * Which result Enter opens. It is kept by thread id so rows that arrive late do not move it,
 * and a new query starts at the top.
 */
export function createSearchHighlight(results: () => SearchResult[]) {
  const highlightKey = signal<string | null>(null);
  effect(() => {
    sidebarThreadQuery();
    highlightKey.set(null);
  });
  const keys = () => results().map((result) => result.thread.id);
  return {
    highlightedIndex: () => activeSearchIndex(keys(), highlightKey()),
    highlight: (threadId: string) => highlightKey.set(threadId),
    move: (step: 1 | -1) => highlightKey.set(moveSearchHighlight(keys(), highlightKey(), step)),
    /** Enter: opens the highlighted result. */
    openHighlighted: (onSelect: (id: string) => void) => {
      const result = results()[activeSearchIndex(keys(), highlightKey())];
      if (result) selectSidebarSearchResult(result, onSelect);
    },
  };
}

/** Up and Down move the highlight and Escape clears the query, while the field has the keyboard. */
export function bindSearchKeys(focused: () => boolean, hasResults: () => boolean, move: (step: 1 | -1) => void) {
  effect(() => {
    if (!focused() || !sidebarThreadQuery().trim()) return;
    return keymap.bind({
      escape: () => setSidebarThreadQuery(""),
      ...(hasResults() ? { up: () => move(-1), down: () => move(1) } : {}),
    }, { when: "always", repeat: true });
  });
}

export function createSidebarThreadSearch() {
  const matches = signal<SidebarMessageMatch[]>([]);

  const pending = signal(false);
  const error = signal("");
  const attempt = signal(0);
  effect(() => {
    // A pasted wall of text searches by its start; messages need a word of three or more letters (useThreadSearch).
    const query = normalizeThreadSearchQuery(sidebarThreadQuery());
    const connected = backendStatus() === "connected";
    // A change of destination invalidates results even if the query did not change.
    backendUrl();
    attempt();
    matches.set([]);
    error.set("");
    pending.set(false);
    if (!connected || !canSearchThreadMessages(query)) return;
    let active = true;
    pending.set(true);
    const timer = setTimeout(() => {
      void requestBackend("orchestration.searchThreads", { query, limit: 50 }).then((response) => {
        if (!active) return;
        matches.set(parseSidebarMessageMatches(response));
      }).catch((cause: unknown) => {
        if (active) error.set(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => {
        if (active) pending.set(false);
      });
    }, THREAD_SEARCH_DEBOUNCE_MS);
    return () => { active = false; clearTimeout(timer); };
  });

  const results = (): SearchResult[] => {
    const query = sidebarThreadQuery().trim().slice(0, 200).toLowerCase();
    if (!query) return [];
    const projects = allProjects();
    const local = allThreads().filter((thread) =>
      thread.title.toLowerCase().includes(query) ||
      projects.some((project) => project.id === thread.projectId && project.name.toLowerCase().includes(query)),
    );
    const seen = new Set(local.map((thread) => thread.id));
    const found: SearchResult[] = local.map((thread) => ({ thread, match: matches().find((match) => match.threadId === thread.id) ?? null }));
    for (const match of matches()) {
      if (seen.has(match.threadId)) continue;
      const thread = threadById(match.threadId);
      if (!thread) continue;
      seen.add(thread.id);
      found.push({ thread, match });
    }
    return found;
  };

  return {
    results,
    ...createSearchHighlight(results),
    pending: () => pending(),
    error: () => error(),
    retry: () => attempt.update((value) => value + 1),
  };
}

/** ThreadSearchMatchExcerpt: the snippet cut at the query's words, which show in semibold foreground. */
export function excerptParts(snippet: string, query: string) {
  return splitSearchText(snippet, findSearchTokenRanges(snippet, normalizeThreadSearchQuery(query)));
}

function SearchProjectMark(props: { projectId: string }) {
  const project = () => allProjects().find((item) => item.id === props.projectId);
  return <>{project() ? <ProjectTile name={project()!.name} projectId={props.projectId} /> : null}</>;
}

type SearchState = ReturnType<typeof createSidebarThreadSearch>;

export function SidebarThreadSearch(props: {
  search: Pick<SearchState, "results" | "pending" | "error" | "retry"> & Partial<Pick<SearchState, "highlightedIndex" | "highlight">>;
  onSelect: (id: string) => void;
}) {
  const highlightedId = () => props.search.results()[props.search.highlightedIndex?.() ?? 0]?.thread.id;
  return (
    <View class="gap-px">
      <Each of={props.search.results()} key={(result) => result.thread.id}>
        {(result) => (
          <View
            role="button"
            accessibilityLabel={`Open search result ${result().thread.title}`}
            accessibilityState={{ selected: highlightedId() === result().thread.id }}
            onPress={() => selectSidebarSearchResult(result(), props.onSelect)}
            onMouseMove={() => {
              if (highlightedId() !== result().thread.id) props.search.highlight?.(result().thread.id);
            }}
            class={`min-h-9 flex-row items-center gap-2.5 rounded-md px-2.5 py-1 ${
              highlightedId() === result().thread.id || openThread()?.id === result().thread.id
                ? "bg-sidebar-row-active"
                : "hover:bg-sidebar-row-hover"
            }`}
          >
            <SearchProjectMark projectId={result().thread.projectId} />
            <View class="min-w-0 flex-1">
              <View class="flex-row items-center gap-2">
                <Text class="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">{result().thread.title}</Text>
                <Text class="text-xs text-sidebar-muted-foreground">{sidebarRelativeTime(result().thread.updatedAt)}</Text>
              </View>
              {result().match ? (
                <Text class="truncate text-xs text-sidebar-muted-foreground">
                  <Text class={result().match?.source === "user" ? "text-info-foreground" : "text-success-foreground"}>
                    {result().match?.source === "user" ? "You:" : "Agent:"}
                  </Text>
                  {" "}
                  <Each of={excerptParts(result().match?.snippet ?? "", sidebarThreadQuery())} key={(part) => part.start}>
                    {(part) => <Text class={part().highlighted ? "font-semibold text-foreground" : ""}>{part().text}</Text>}
                  </Each>
                </Text>
              ) : null}
            </View>
          </View>
        )}
      </Each>
      {props.search.results().length === 0 && props.search.pending() ? (
        <Text class="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">Searching thread messages…</Text>
      ) : null}
      {!props.search.pending() && props.search.error() ? (
        <View class="items-center gap-2 px-2 py-4">
          <Text class="text-center text-xs text-destructive">{props.search.error()}</Text>
          <View role="button" accessibilityLabel="Retry thread search" onPress={props.search.retry} class="rounded-md border border-border px-2 py-1">
            <Text class="text-xs text-foreground">Retry</Text>
          </View>
        </View>
      ) : null}
      {!props.search.pending() && !props.search.error() && props.search.results().length === 0 ? (
        <Text class="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">No threads found</Text>
      ) : null}
    </View>
  );
}
