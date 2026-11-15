import { mount, Text, View } from "nsh";
import { applyShellEventForTest } from "../../store";
import { ProjectScopeMenu } from "./ProjectScopeMenu";
import { projectScopeIds } from "./projectScope";

const iso = new Date().toISOString();
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: ["Alpha", "Beta", "Gamma"].map((title, index) => ({ id: `p${index}`, title, workspaceRoot: `/w/${title}`, pinnedAt: null, createdAt: iso, updatedAt: iso })),
  threads: [],
} });

mount(() => (
  <View class="w-[320px] bg-sidebar p-2">
    <ProjectScopeMenu />
    <Text>{`scope ${projectScopeIds().join(",") || "all"}`}</Text>
  </View>
));
