import { expect, test } from "nsh/test";
import { launcherHandlesRelaunch, relaunchDir, requestRelaunch, type RelaunchIo } from "./relaunchRequest";

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

test("without T3GPUI_LAUNCHER_HANDLES_RELAUNCH (the installed macOS launcher), the default dir is null and nothing is written", async () => {
  const env = { T3GPUI_BOOTSTRAP_FILE: "/home/.t3codegpui/bootstrap/bootstrap-x.json" };
  expect(launcherHandlesRelaunch(env)).toBe(false);
  const io: RelaunchIo = { write: async () => { throw new Error("should not be called"); }, rename: async () => { throw new Error("should not be called"); } };
  expect(await requestRelaunch("reason", { io, env })).toBe(false);
});

test("with T3GPUI_LAUNCHER_HANDLES_RELAUNCH=1 (tools/run_local.py), the default dir resolves and the request is written", async () => {
  const env = { T3GPUI_BOOTSTRAP_FILE: "/home/.t3codegpui/bootstrap/bootstrap-x.json", T3GPUI_LAUNCHER_HANDLES_RELAUNCH: "1" };
  expect(launcherHandlesRelaunch(env)).toBe(true);
  expect(relaunchDir(env)).toBe("/home/.t3codegpui/bootstrap");
  const files = new Map<string, string>();
  const io: RelaunchIo = {
    write: async (p, t) => { files.set(p, t); },
    rename: async (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
  };
  const ok = await requestRelaunch("reason", { io, env, id: () => "r2" });
  expect(ok).toBe(true);
  expect(JSON.parse(files.get("/home/.t3codegpui/bootstrap/relaunch-request.json")!)).toEqual({ id: "r2", reason: "reason" });
});
