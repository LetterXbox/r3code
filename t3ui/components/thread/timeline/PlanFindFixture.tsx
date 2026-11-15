// ProposedPlanCard findRevealRef: a collapsed plan opens when the active find match is inside its hidden lines.
import { mount, Scroll, Text, View } from "nsh";
import { ProposedPlanCard } from "./TimelineRows";
import { threadFindActive, threadFindOpen, threadFindQuery } from "../threadFindState";
import type { WorkItem } from "./workLog";

const plan: WorkItem = { id: "p1", type: "proposed_plan", title: "Plan", detail: `# Big plan\n\n${Array.from({ length: 30 }, (_, index) => `- step ${index + 1}${index === 27 ? " hiddenneedle" : ""}`).join("\n")}`, status: "completed" };

mount(() => (
  <Scroll class="flex-1">
    <View accessibilityLabel="Find hidden" role="button" onPress={() => { threadFindOpen.set(true); threadFindQuery.set("hiddenneedle"); threadFindActive.set({ rowId: "activity:p1", occurrence: 0 }); }}><Text>find</Text></View>
    <ProposedPlanCard item={() => plan} workspaceRoot={() => "/w"} findRowId={() => "activity:p1"} request={async () => ({})} download={async () => ""} />
  </Scroll>
));
