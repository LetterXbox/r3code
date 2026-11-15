import { expect, test } from "nsh/test";
import { loadCleanupReport, loadDatabaseStatus } from "./Storage";

// server.getStorageCleanupReport and server.getDatabaseStorage are streams (contracts rpc.ts `stream: true`): a plain
// request never resolves because the client drops stream chunks for requests. They must be subscribed, like the web does.
test("the cleanup report and database status are read as subscriptions and stop on cleanup", () => {
  const calls: string[] = [];
  let stopped = 0;
  const subscribe = (method: string, _payload: unknown, onValue: (value: unknown) => void) => {
    calls.push(method);
    onValue(null);
    return () => { stopped += 1; };
  };
  const stopReport = loadCleanupReport(subscribe);
  const stopDatabase = loadDatabaseStatus(subscribe);
  expect(calls).toEqual(["server.getStorageCleanupReport", "server.getDatabaseStorage"]);
  stopReport();
  stopDatabase();
  expect(stopped).toBe(2);
});
