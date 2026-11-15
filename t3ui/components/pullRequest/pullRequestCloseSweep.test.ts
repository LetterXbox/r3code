import { expect, test } from "nsh/test";
import { clearToasts, toasts } from "../toast/toastState";
import { closeBatch, keyAtY, resolveSweepKeys } from "./pullRequestCloseSweep";
import type { PullRequestEntry } from "../../pages/utility-data";

test("a sweep covers the rows between where it started and the row under the pointer, either way", () => {
  const keys = ["a", "b", "c", "d"];
  expect(resolveSweepKeys(keys, "b", "d", () => true)).toEqual(["b", "c", "d"]);
  expect(resolveSweepKeys(keys, "c", "a", (key) => key !== "b")).toEqual(["a", "c"]);
  expect(keyAtY([{ key: "a", top: 0 }, { key: "b", top: 40 }, { key: "c", top: 80 }], 55)).toBe("b");
});

test("a batch closes each open one and says how many closed, with the first failures", async () => {
  clearToasts();
  const entry = (number: number) => ({ projectId: "p", host: "github.com", repository: "o/r", number, state: "open", provider: "github" }) as unknown as PullRequestEntry;
  let reloaded = 0;
  await closeBatch([entry(1), entry(2)], async (_method, payload) => { if ((payload as { number: number }).number === 2) throw new Error("Base branch was modified"); return {}; }, () => { reloaded++; });
  expect(toasts().map((toast) => [toast.title, toast.description])).toEqual([["Closed 1 of 2 pull requests", "#2: Base branch was modified"]]);
  expect(reloaded).toBe(1);
});
