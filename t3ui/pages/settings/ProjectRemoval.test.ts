import { expect, test } from "nsh/test";
import { dangerRowCopy, planProjectRemoval } from "./projectsLogic";

const member = (id: string, title = "app") => ({ id, environmentId: "e1", title, workspaceRoot: `/w/${id}`, environmentLabel: "Mac" });

test("removing a lone project reads as the reference's planner does", () => {
  const plan = planProjectRemoval({ members: [member("a")], groupMemberCount: 1, hasOtherMembers: false, displayName: "app", threadCount: 2 });
  expect(plan.targetKind).toBe("project");
  expect(plan.confirmationMessage).toBe('Remove project "app" and delete its 2 threads?\nPath: /w/a\nEnvironment: Mac\nThose threads and any archived threads are deleted from R3 Code. Provider sessions are kept.\nThis removes only the project entries, not the files on disk.\nThis action cannot be undone.');
});

test("one checkout of a group is a checkout, and the whole group says how many entries", () => {
  const one = planProjectRemoval({ members: [member("a")], groupMemberCount: 2, hasOtherMembers: true, displayName: "app", threadCount: 0 });
  expect(one.targetKind).toBe("checkout");
  expect(one.confirmationMessage).toContain("Other entries in this grouped project are unaffected.");
  const all = planProjectRemoval({ members: [member("a"), member("b")], groupMemberCount: 2, hasOtherMembers: false, displayName: "app", threadCount: 1 });
  expect(all.confirmationMessage).toContain('Remove project "app" and delete its 1 thread?\nThis removes 2 grouped project entries.');
  expect(dangerRowCopy(2, false).button).toBe("Remove all entries");
  expect(dangerRowCopy(2, true).title).toBe("Remove checkout");
  expect(dangerRowCopy(1, false).title).toBe("Remove project");
});
