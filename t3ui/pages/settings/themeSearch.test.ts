// The cases of ThemeSearchSection.test.ts (createThemeSearch), on real timers with a short debounce.
import { expect, test } from "nsh/test";
import { createThemeSearch, type ThemeSearchView } from "./themeSearch";
import type { OpenVsxThemeExtension, OpenVsxThemeSort } from "./openVsxThemes";

const DEBOUNCE = 25;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Request { query: string; sortBy: OpenVsxThemeSort | undefined; signal: AbortSignal | undefined; resolve(results: OpenVsxThemeExtension[]): void; reject(cause: unknown): void }

function setup() {
  const requests: Request[] = [];
  const search = (query: string, options: { signal?: AbortSignal; sortBy?: OpenVsxThemeSort } = {}) =>
    new Promise<OpenVsxThemeExtension[]>((resolve, reject) => { requests.push({ query, sortBy: options.sortBy, signal: options.signal, resolve, reject }); });
  const view = { results: null as ReadonlyArray<OpenVsxThemeExtension> | null, error: null as string | null, isSearching: false };
  const sink: ThemeSearchView = {
    setResults: (results) => { view.results = results; },
    setError: (error) => { view.error = error; },
    setIsSearching: (isSearching) => { view.isSearching = isSearching; },
  };
  const session = new AbortController();
  return { requests, view, session, themeSearch: createThemeSearch(sink, session.signal, search, DEBOUNCE) };
}

const extension = (name: string) => ({ name }) as OpenVsxThemeExtension;

test("it searches once the typed query settles", async () => {
  const env = setup();
  env.themeSearch.setQuery("dra");
  env.themeSearch.setQuery("dracula ");
  await sleep(DEBOUNCE / 2);
  expect(env.requests).toHaveLength(0);
  await until(() => env.requests.length === 1, "the search");
  expect(env.requests.map((request) => request.query)).toEqual(["dracula"]);
  expect(env.view.isSearching).toBe(true);
  env.requests[0]!.resolve([extension("Dracula")]);
  await until(() => !env.view.isSearching, "the results");
  expect(env.view.results).toEqual([extension("Dracula")]);
});

test("it keeps the shown results when typing returns to their query", async () => {
  const env = setup();
  env.themeSearch.setQuery("nord");
  await until(() => env.requests.length === 1, "the first search");
  env.requests[0]!.resolve([extension("Nord")]);
  await until(() => env.view.results !== null, "the results");
  env.themeSearch.setQuery("nordic");
  await until(() => env.requests.length === 2, "the second search");
  env.themeSearch.setQuery("nord");
  await until(() => env.requests[1]!.signal?.aborted === true && !env.view.isSearching, "the second search to be dropped");
  expect(env.requests).toHaveLength(2);
  expect(env.view.results).toEqual([extension("Nord")]);
});

test("it searches again right away when the sort changes", async () => {
  const env = setup();
  env.themeSearch.setQuery("nord");
  await until(() => env.requests.length === 1, "the search");
  env.themeSearch.setSortBy("rating");
  expect(env.requests[0]!.signal?.aborted).toBe(true);
  expect(env.requests[1]).toMatchObject({ query: "nord", sortBy: "rating" });
});

test("clearing the query drops results and the request in flight", async () => {
  const env = setup();
  env.themeSearch.setQuery("nord");
  await until(() => env.requests.length === 1, "the search");
  env.themeSearch.setQuery("  ");
  expect(env.requests[0]!.signal?.aborted).toBe(true);
  expect(env.view).toEqual({ results: null, error: null, isSearching: false });
});

test("a failed search shows its message and no results", async () => {
  const env = setup();
  env.themeSearch.setQuery("nord");
  await until(() => env.requests.length === 1, "the search");
  env.requests[0]!.reject(new Error("Open VSX search is unavailable right now."));
  await until(() => env.view.error !== null, "the error");
  expect(env.view).toEqual({ results: null, error: "Open VSX search is unavailable right now.", isSearching: false });
});

test("searches are held during an install, whose error stays on the shown query", async () => {
  const env = setup();
  env.themeSearch.setQuery("nord");
  await until(() => env.requests.length === 1, "the search");
  env.requests[0]!.resolve([extension("Nord")]);
  await until(() => env.view.results !== null, "the results");
  const install = env.themeSearch.beginInstall();
  env.view.error = "That theme could not be added.";
  env.themeSearch.searchNow();
  expect(env.requests).toHaveLength(1);
  expect(env.themeSearch.endInstall(install)).toBe(true);
  expect(env.requests).toHaveLength(1);
  expect(env.view.error).toBe("That theme could not be added.");
  const next = env.themeSearch.beginInstall();
  env.themeSearch.setQuery("dracula");
  await sleep(DEBOUNCE * 3);
  expect(env.requests).toHaveLength(1);
  env.themeSearch.endInstall(next);
  expect(env.requests.map((request) => request.query)).toEqual(["nord", "dracula"]);
  expect(env.view.error).toBeNull();
});

test("Enter during the debounce searches once", async () => {
  const env = setup();
  env.themeSearch.setQuery("nord");
  env.themeSearch.searchNow();
  await sleep(DEBOUNCE * 3);
  expect(env.requests.map((request) => request.query)).toEqual(["nord"]);
  expect(env.requests[0]!.signal?.aborted).toBe(false);
});

test("closing the session aborts the search, the debounce and the install", async () => {
  const env = setup();
  env.themeSearch.setQuery("nord");
  await until(() => env.requests.length === 1, "the search");
  const install = env.themeSearch.beginInstall();
  env.themeSearch.setQuery("dracula");
  env.session.abort();
  await sleep(DEBOUNCE * 3);
  expect(env.requests[0]!.signal?.aborted).toBe(true);
  expect(install.aborted).toBe(true);
  expect(env.requests).toHaveLength(1);
});
