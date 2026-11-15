import { expect, test } from "nsh/test";
import { requestRelaunch, type RelaunchIo } from "./relaunchRequest";

test("without a launcher directory, nothing is written and the caller is told so", async () => {
  const io: RelaunchIo = { write: async () => { throw new Error("should not be called"); }, rename: async () => { throw new Error("should not be called"); } };
  expect(await requestRelaunch("reason", { dir: null, io })).toBe(false);
});

test("the request is written atomically (tmp then rename) with an id and the reason", async () => {
  const files = new Map<string, string>();
  const io: RelaunchIo = {
    write: async (p, t) => { files.set(p, t); },
    rename: async (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
  };
  const ok = await requestRelaunch("localEnvironmentEnabled=false", { dir: "/b", io, id: () => "r1" });
  expect(ok).toBe(true);
  expect(files.has("/b/relaunch-request.json.tmp")).toBe(false);
  expect(JSON.parse(files.get("/b/relaunch-request.json")!)).toEqual({ id: "r1", reason: "localEnvironmentEnabled=false" });
});
