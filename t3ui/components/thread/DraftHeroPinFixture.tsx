// DraftHeroHeadline with the live store: the project picker's per-row pin button and the thread pin shortcut.
import { mount, signal, Text, View } from "nsh";
import { applyConfigEventForTest, applyShellEventForTest, setRequestBackendForTest } from "../../store";
import { DraftHeroHeadline } from "./DraftHero";

const iso = new Date().toISOString();
applyConfigEventForTest({ type: "snapshot", config: { providers: [], environment: { environmentId: "env-1", label: "Local", capabilities: { projectOrganization: true } } } });
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: ["Alpha", "Beta"].map((title, index) => ({ id: `p${index}`, title, workspaceRoot: `/w/${title}`, pinnedAt: null, createdAt: iso, updatedAt: iso })),
  threads: [],
} });
const calls = signal<string[]>([]);
setRequestBackendForTest(async (method, payload) => {
  const body = payload as { projectId?: string; pinned?: boolean };
  calls.update((list) => [...list, `${method}:${body.projectId}:${body.pinned}`]);
  return {};
});

mount(() => (
  <View class="w-[1000px]">
    <DraftHeroHeadline projectId={() => "p0"} />
    <Text>{`calls ${calls().join(",") || "none"}`}</Text>
  </View>
));
