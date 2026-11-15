import { expect, test } from "nsh/test";
import { rootErrorMessage, rootErrorReport } from "./rootErrorReport";

test("the error message is the error's own, else a plain sentence", () => {
  expect(rootErrorMessage(new Error("boom"))).toBe("boom");
  expect(rootErrorMessage("text")).toBe("text");
  expect(rootErrorMessage({})).toBe("An unexpected router error occurred.");
  expect(rootErrorMessage(new Error("  "))).toBe("An unexpected router error occurred.");
});

test("the report names the app, path and time, then the error and the chain of causes", () => {
  const inner = new Error("inner");
  const outer = new Error("outer", { cause: inner });
  const report = rootErrorReport(outer, { appName: "R3 Code", version: "1.2.3", path: "/", now: new Date("2026-11-11T10:00:00.000Z") });
  const lines = report.split("\n");
  expect(lines.slice(0, 4)).toEqual(["R3 Code 1.2.3", "Path: /", "Time: 2026-11-11T10:00:00.000Z", ""]);
  expect(report).toContain("outer");
  expect(report).toContain("Caused by:");
  expect(report).toContain("inner");
});

test("a thrown string and a plain object still make a report", () => {
  expect(rootErrorReport("oops", { appName: "A", version: "1", path: "/" })).toContain("oops");
  expect(rootErrorReport({ code: 7 }, { appName: "A", version: "1", path: "/" })).toContain('"code": 7');
});
