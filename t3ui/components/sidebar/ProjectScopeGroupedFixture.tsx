import { mount, Text, View } from "nsh";
import { applyShellEventForTest, updateSetting } from "../../store";
import { ProjectScopeMenu } from "./ProjectScopeMenu";
import { projectScopeIds } from "./projectScope";

const repositoryIdentity = { canonicalKey: "github.com/acme/shop", displayName: "acme/shop", rootPath: "/work/shop" };
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: [
    { id: "shop-a", title: "shop", workspaceRoot: "/work/shop", repositoryIdentity, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
    { id: "shop-b", title: "shop", workspaceRoot: "/other/shop", repositoryIdentity, createdAt: "2025-01-02T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z" },
    { id: "other", title: "Other", workspaceRoot: "/work/other", createdAt: "2025-01-03T00:00:00Z", updatedAt: "2025-01-03T00:00:00Z" },
  ],
  threads: [],
} });
updateSetting("sidebarProjectGroupingMode", "repository");
updateSetting("sidebarProjectSortOrder", "updated_at");

mount(() => <View class="w-[320px] bg-sidebar p-2"><ProjectScopeMenu /><Text>{`scope ${projectScopeIds().join(",") || "all"}`}</Text></View>);
