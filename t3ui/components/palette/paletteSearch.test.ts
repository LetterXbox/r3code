import { expect, test } from "nsh/test";
import { CONTENT_LIMIT, FILE_LIMIT, clampPathQuery, createPaletteSearch } from "./paletteSearch";

test("file and content searches ask for the reference's limits and cut a long query to 256 characters", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const search = createPaletteSearch({ debounceMs: 0, request: async (method, payload) => { calls.push([method, payload as Record<string, unknown>]); return method === "projects.searchEntries" ? { entries: [], truncated: false } : { matches: [], truncated: false }; } });
  search.searchFiles("/repo", `  ${"a".repeat(300)}  `);
  search.searchContent("/repo", "needle");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const entries = calls.find(([method]) => method === "projects.searchEntries");
  const contents = calls.find(([method]) => method === "projects.searchContents");
  expect(FILE_LIMIT).toBe(200);
  expect(CONTENT_LIMIT).toBe(500);
  expect(entries).toBeUndefined();
  expect(contents?.[1].limit).toBe(500);
  search.searchFiles("/repo", "x".repeat(300));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = calls.find(([method]) => method === "projects.searchEntries");
  expect((second?.[1].query as string).length).toBe(256);
  expect(second?.[1].limit).toBe(200);
  expect(clampPathQuery(`${"a".repeat(255)}\u{1F600}`)).toBe("a".repeat(255));
});
