import { expect, test } from "nsh/test";
import { resolveDiffPathForWorkspace } from "./diffFileActions";

test("diff paths resolve like the reference's resolveDiffPathForWorkspace (fm13)", () => {
  expect(resolveDiffPathForWorkspace({ filePath: "/repo/app/src/a.ts", workspaceRoot: "/repo/app" })).toBe("src/a.ts");
  expect(resolveDiffPathForWorkspace({ filePath: "/elsewhere/a.ts", workspaceRoot: "/repo/app" })).toBe(null);
  expect(resolveDiffPathForWorkspace({ filePath: "C:\\Repo\\App\\src\\a.ts", workspaceRoot: "c:\\repo\\app" })).toBe("src/a.ts");
  expect(resolveDiffPathForWorkspace({ filePath: "app/src/a.ts", workspaceRoot: "/repo/app", repositoryRoot: "/repo" })).toBe("src/a.ts");
  expect(resolveDiffPathForWorkspace({ filePath: "other/a.ts", workspaceRoot: "/repo/app", repositoryRoot: "/repo" })).toBe(null);
  expect(resolveDiffPathForWorkspace({ filePath: "App/a.ts", workspaceRoot: "C:\\Repo\\App", repositoryRoot: "C:\\Repo" })).toBe("a.ts");
  expect(resolveDiffPathForWorkspace({ filePath: "src/a.ts", workspaceRoot: "/work", repositoryRoot: "/repo" })).toBe("src/a.ts");
  expect(resolveDiffPathForWorkspace({ filePath: "../a.ts", workspaceRoot: "/repo" })).toBe(null);
});
