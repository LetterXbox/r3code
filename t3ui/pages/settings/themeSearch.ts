// Owns one Add-a-theme session's Open VSX traffic (createThemeSearch of ThemeSearchSection.tsx): the input debounce,
// the request in flight, and which key the shown results belong to. Aborting the session's `signal` (the dialog
// closing) cancels all of it, including an install.
import { searchOpenVsxThemes, type OpenVsxThemeExtension, type OpenVsxThemeSort } from "./openVsxThemes";

export const SEARCH_DEBOUNCE_MS = 350;

export interface ThemeSearchView {
  readonly setResults: (results: ReadonlyArray<OpenVsxThemeExtension> | null) => void;
  readonly setError: (error: string | null) => void;
  readonly setIsSearching: (isSearching: boolean) => void;
}

type SearchThemes = typeof searchOpenVsxThemes;

export function createThemeSearch(view: ThemeSearchView, signal: AbortSignal, search: SearchThemes = searchOpenVsxThemes, debounceMs: number = SEARCH_DEBOUNCE_MS) {
  let query = "";
  let sortBy: OpenVsxThemeSort = "downloadCount";
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let request: AbortController | null = null;
  let install: AbortController | null = null;
  // Record successful searches only; rerun after install only for changed query/sort to preserve install errors.
  let shownKey: string | null = null;
  let handledKey: string | null = null;
  let interrupted = false;

  const keyOf = () => `${query}\u0000${sortBy}`;
  const abortRequest = () => {
    request?.abort();
    request = null;
  };
  const cancelDebounce = () => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
  };

  const fetchResults = () => {
    abortRequest();
    const controller = new AbortController();
    request = controller;
    const key = keyOf();
    void search(query, { signal: controller.signal, sortBy })
      .then(
        (results) => {
          if (controller.signal.aborted) return;
          view.setResults(results);
          shownKey = key;
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          view.setResults(null);
          shownKey = null;
          view.setError(cause instanceof Error ? cause.message : "Open VSX search failed.");
        },
      )
      .then(() => {
        if (request !== controller) return;
        request = null;
        view.setIsSearching(false);
      });
  };

  const clear = () => {
    cancelDebounce();
    abortRequest();
    shownKey = null;
    handledKey = null;
    view.setResults(null);
    view.setError(null);
    view.setIsSearching(false);
  };

  const settle = () => {
    if (install !== null || signal.aborted || query === "") return;
    const key = keyOf();
    const keyChanged = handledKey !== key;
    if (!keyChanged && !interrupted) return;
    handledKey = key;
    interrupted = false;
    const shouldFetch = shownKey !== key;
    if (shouldFetch || keyChanged) view.setError(null);
    view.setIsSearching(shouldFetch);
    if (shouldFetch) fetchResults();
    else abortRequest();
  };

  signal.addEventListener(
    "abort",
    () => {
      cancelDebounce();
      abortRequest();
      install?.abort();
    },
    { once: true },
  );

  return {
    /** An unsettled query would hit Open VSX for text that is no longer visible, so typing waits. */
    setQuery(nextQuery: string) {
      const trimmed = nextQuery.trim();
      if (trimmed === query) return;
      query = trimmed;
      cancelDebounce();
      if (trimmed === "") {
        if (install === null) clear();
        return;
      }
      debounce = setTimeout(() => {
        debounce = null;
        settle();
      }, debounceMs);
    },
    setSortBy(nextSort: OpenVsxThemeSort) {
      sortBy = nextSort;
      if (debounce === null) settle();
    },
    /** Enter or re-picking the current suggestion searches again even for the shown key. */
    searchNow() {
      if (install !== null || signal.aborted || query === "") return;
      // A pending debounce for the same key would otherwise restart this search.
      cancelDebounce();
      handledKey = keyOf();
      interrupted = false;
      view.setError(null);
      view.setIsSearching(true);
      fetchResults();
    },
    beginInstall(): AbortSignal {
      abortRequest();
      install?.abort();
      install = new AbortController();
      interrupted = true;
      view.setIsSearching(false);
      return install.signal;
    },
    endInstall(installSignal: AbortSignal): boolean {
      if (install?.signal !== installSignal) return false;
      install = null;
      if (query === "") clear();
      else if (debounce === null) settle();
      return true;
    },
  };
}
