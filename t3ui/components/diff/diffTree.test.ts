import { expect, test } from "nsh/test";
import { compactCount, diffTreeRows, directoryIds, fileStatus, statusMark, totalStat } from "./diffTree";
import type { ChangedFile } from "./data";

const file = (path: string, additions = 1, deletions = 0, previousPath: string | null = null): ChangedFile => ({ path, previousPath, additions, deletions });

test("folders that only hold one folder merge into one row", () => {
  const rows = diffTreeRows([file("src/lib/a.ts"), file("src/lib/b.ts"), file("readme.md")], new Set());
  expect(rows.map((row) => [row.kind, row.label, row.depth])).toEqual([
    ["directory", "src/lib", 0], ["file", "a.ts", 1], ["file", "b.ts", 1], ["file", "readme.md", 0],
  ]);
  const split = diffTreeRows([file("src/a.ts"), file("src/lib/b.ts")], new Set());
  expect(split.map((row) => [row.label, row.depth])).toEqual([["src", 0], ["a.ts", 1], ["lib", 1], ["b.ts", 2]]);
});

test("a collapsed folder hides its files and keeps server order", () => {
  const files = [file("z/a.ts"), file("a/b.ts"), file("z/c.ts")];
  expect(diffTreeRows(files, new Set()).map((row) => row.label)).toEqual(["z", "a.ts", "c.ts", "a", "b.ts"]);
  expect(diffTreeRows(files, new Set(["z/"])).map((row) => row.label)).toEqual(["z", "a", "b.ts"]);
  expect(directoryIds(files)).toEqual(["z/", "a/"]);
});

test("status marks, totals and compact counts", () => {
  expect(fileStatus(file("b.ts", 1, 0, "a.ts"))).toBe("renamed");
  expect(fileStatus(file("a.ts"))).toBe("modified");
  expect(statusMark("renamed")).toBe("R");
  expect(totalStat([file("a", 2, 1), file("b", 3, 4)])).toEqual({ additions: 5, deletions: 5 });
  expect(compactCount(999)).toBe("999");
  expect(compactCount(1500)).toBe("1.5k");
  expect(compactCount(12000)).toBe("12k");
  expect(compactCount(2_500_000)).toBe("2.5m");
});

test("turn changed files sort folders first and total their nested changes", () => {
  const rows = diffTreeRows([file("deno.lock", 5, 4), file("src/broker/.netlify/a", 12, 1), file("src/broker/.netlify/b", 8, 1)], new Set(["src/broker/.netlify/"]), { directoriesFirst: true });
  expect(rows.map((row) => row.label)).toEqual(["src/broker/.netlify", "deno.lock"]);
  expect(rows[0]?.stat).toEqual({ additions: 20, deletions: 2 });
});

test("turn changed files normalize Windows and repeated separators without losing the original file key", () => {
  const original = file("src\\broker//config.ts");
  const rows = diffTreeRows([original, file("///"), file("src/broker/other.ts")], new Set(), { directoriesFirst: true });
  expect(rows.map((row) => row.label)).toEqual(["src/broker", "config.ts", "other.ts"]);
  expect(rows[1]?.file?.path).toBe(original.path);
});
