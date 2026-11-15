import { expect, test } from "nsh/test";
import { classifyChangedFile, isTestChangedFile } from "./changedFileKind";

test("tests and their support files are test files, lockfiles and docs are not", () => {
  for (const path of ["src/a.test.ts", "pkg/b_spec.rb", "tests/x.ts", "app/__mocks__/y.ts", "snap/z.snap", "src/FooTest.java", "test_util.py"]) expect(isTestChangedFile(path)).toBe(true);
  for (const path of ["src/Latest.java", "src/app.ts", "README.md", "pnpm-lock.yaml"]) expect(isTestChangedFile(path)).toBe(false);
});

test("generated wins over test, and prose is docs", () => {
  expect(classifyChangedFile("tests/foo.generated.ts")).toBe("generated");
  expect(classifyChangedFile("notes.md")).toBe("docs");
  expect(classifyChangedFile("requirements.txt")).toBe("code");
});
