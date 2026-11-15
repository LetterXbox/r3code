import { expect, test } from "nsh/test";
import { syncRunningThreadKeepAlive } from "./runningThreadKeepAlive";

test("running threads other than the open one are kept, and released once they stop", () => {
  expect(syncRunningThreadKeepAlive(["a", "b"], "a").join(",")).toBe("b");
  expect(syncRunningThreadKeepAlive(["a", "b", "c"], "a").join(",")).toBe("b,c");
  expect(syncRunningThreadKeepAlive(["c"], null).join(",")).toBe("c");
  expect(syncRunningThreadKeepAlive([], null).length).toBe(0);
});
