import { expect, open, test } from "nsh/test";
import { hasRpcResultSchema, rpcResultSchemaIssue } from "./backend/rpcResultSchema";

test("R3 Code opens its main window cleanly on Windows NSH v0.7", async () => {
  const app = await open("./App.tsx", { platform: "windows", width: 1280, height: 840 });
  await app.waitUntil(() => app.window("main").state()?.visible === true, { timeout: 5000 });
  expect(app.window("main").state()).toMatchObject({ visible: true });
  expect(app.texts().length).toBeGreaterThan(0);
});

test("staged Windows bundle retains RPC result schema validation", () => {
  expect(hasRpcResultSchema("vcs.listRefs")).toBe(true);
  expect(rpcResultSchemaIssue("vcs.listRefs", {})).not.toBe(null);
});
