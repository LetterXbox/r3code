import { expect, test } from "nsh/test";
import { addProjectToMachine, cloneUrlForProtocol, defaultSelection, projectFileCopies, projectSubdirectory } from "./addProjectToMachine";

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

test("clone URL helpers and defaults follow the reference", () => {
  expect(cloneUrlForProtocol("https://github.com/o/r.git", "ssh")).toBe("git@github.com:o/r.git");
  expect(cloneUrlForProtocol("git@github.com:o/r.git", "https")).toBe("https://github.com/o/r.git");
  expect(cloneUrlForProtocol("ssh://git@host:2222/o/r", "https")).toBe(null);
  expect([...defaultSelection([{ path: "a/.env.local", byteLength: 10 }, { path: "big/.env", byteLength: 2_000_000 }, { path: "x.txt", byteLength: 1 }])].join(",")).toBe("a/.env.local");
  expect(projectSubdirectory("/r", "/r/apps/web")).toBe("apps/web");
});

test("addProjectToMachine starts the clone, waits for done, then relays the files to the target", async () => {
  const calls: { method: string; payload: any }[] = [];
  let push: ((value: unknown) => void) | null = null;
  await addProjectToMachine({
    source: { request: async (method, payload) => { calls.push({ method, payload }); return { contents: "A=1", truncated: false }; }, cwd: "/src/apps/web" },
    subdirectory: "apps/web",
    target: {
      key: "saved:box", label: "box",
      request: async (method, payload) => { calls.push({ method, payload }); return method === "projectClone.start" ? { cwd: "/dst" } : {}; },
      subscribe: (_method, _payload, onValue) => { push = onValue; return () => {}; },
    },
    projectId: "p1", title: "web", remoteUrl: "git@github.com:o/r.git", destinationPath: "/dst", files: [".env"],
  });
  expect(calls.some((call) => call.method === "projectClone.start" && call.payload.destinationPath === "/dst")).toBe(true);
  expect(projectFileCopies()["saved:box:p1"]?.phase).toBe("copying");
  await until(() => push !== null);
  push!([{ projectId: "p1", phase: "done" }]);
  await until(() => calls.some((call) => call.method === "projects.writeFile"));
  const write = calls.find((call) => call.method === "projects.writeFile")!;
  expect(write.payload.relativePath).toBe("apps/web/.env");
  expect(write.payload.cwd).toBe("/dst");
  await until(() => projectFileCopies()["saved:box:p1"] === undefined);
});
