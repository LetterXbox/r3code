import { expect, open, test } from "nsh/test";
import { readServerFindResult, rowIdsForEntry, serverFindLabel, startForRow } from "./threadFindServer";
import { formatThreadFindCount } from "./threadFind";

test("server find results, row ids, start positions and the bar's labels", () => {
  expect(readServerFindResult({ totalMatches: 2, activeIndex: 1, match: { entryId: "m", runId: null, occurrence: 0 }, complete: false })).toEqual({ totalMatches: 2, activeIndex: 1, match: { entryId: "m", runId: null, occurrence: 0 }, complete: false });
  expect(readServerFindResult(null)).toBe(null);
  expect(rowIdsForEntry("x")).toEqual(["message:x", "activity:x"]);
  expect(startForRow("message:abc")).toEqual({ entryId: "abc", occurrence: 0 });
  expect(startForRow(null)).toBe(undefined);
  const base = { query: "a", status: null, counting: false, activeIndex: 0, total: 3 } as const;
  expect(serverFindLabel({ ...base, status: "loading" }, formatThreadFindCount)).toBe("Searching…");
  expect(serverFindLabel({ ...base, status: "error" }, formatThreadFindCount)).toBe("Search failed");
  expect(serverFindLabel({ ...base, counting: true }, formatThreadFindCount)).toBe("1/…");
  expect(serverFindLabel(base, formatThreadFindCount)).toBe("1/3");
});

test("the bar asks orchestration.searchThread from the viewport, steps with an offset, and retries a failure", async () => {
  const app = await open("./ThreadFindServerFixture.tsx", { width: 700, height: 300 });
  await app.press("label:Open find");
  await app.type("label:Find in thread", "boom");
  await expect(app.texts()).toContain("Search failed");
  await app.press("label:Retry");
  await expect(app.texts()).toContain("1/3");
  await app.press("label:Next match");
  await expect(app.texts()).toContain("2/3");
  await expect(app.texts()).toContain("calls boom|m0|0,boom|m0|0,boom|m0|1");
});
