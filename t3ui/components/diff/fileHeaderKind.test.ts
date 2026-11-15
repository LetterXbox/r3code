import { expect, test } from "nsh/test";
import { headerChangeType, headerPreviousPath } from "./fileHeaderKind";

test("the header's change type follows the patch once loaded, else the metadata", () => {
  const plain = { path: "a.ts", previousPath: null };
  const moved = { path: "new.md", previousPath: "old.md" };
  expect(headerChangeType(plain, null)).toBe("change");
  expect(headerChangeType(moved, null)).toBe("rename");
  expect(headerChangeType(plain, "diff --git a/a.ts b/a.ts\nnew file mode 100644\n")).toBe("new");
  expect(headerChangeType(plain, "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n")).toBe("deleted");
  expect(headerPreviousPath(moved)).toBe("old.md");
  expect(headerPreviousPath({ path: "x", previousPath: "x" })).toBe(null);
});
