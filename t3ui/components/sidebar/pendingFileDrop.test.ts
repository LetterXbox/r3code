import { expect, test } from "nsh/test";
import { dropFilesOnThread, pendingFileDrop, takePendingFileDrop } from "./pendingFileDrop";

test("dropped files wait for their own thread's composer and are handed over once", async () => {
  await dropFilesOnThread("t1", ["file:///a.png", "file:///b.txt"], () => true);
  await expect(pendingFileDrop("t2")).toBeNull();
  await expect(takePendingFileDrop("t2")).toEqual([]);
  await expect(takePendingFileDrop("t1")).toEqual(["file:///a.png", "file:///b.txt"]);
  await expect(takePendingFileDrop("t1")).toEqual([]);
});

test("a drop whose thread did not open is cleared", async () => {
  await dropFilesOnThread("t1", ["file:///a.png"], () => false);
  await expect(pendingFileDrop("t1")).toBeNull();
  await dropFilesOnThread("t1", ["file:///a.png"], () => { throw new Error("route failed"); });
  await expect(pendingFileDrop("t1")).toBeNull();
});

test("fm13: several drops on a thread queue and the composer takes them all", async () => {
  const { queuePendingFileDrop } = await import("./pendingFileDrop");
  queuePendingFileDrop("tq", ["/a"]);
  queuePendingFileDrop("tq", ["/b", "/c"]);
  queuePendingFileDrop("other", ["/x"]);
  expect(pendingFileDrop("tq")?.uris).toEqual(["/a", "/b", "/c"]);
  expect(takePendingFileDrop("tq")).toEqual(["/a", "/b", "/c"]);
  expect(pendingFileDrop("tq")).toBeNull();
  expect(takePendingFileDrop("other")).toEqual(["/x"]);
});
