import { mount, Scroll, signal, Text, View } from "nsh";
import { registeredOverlays } from "../../rightPanel/nativeOcclusion";
import { ProposedPlanCard } from "./TimelineRows";
import { ToastHost } from "../../toast";
import type { WorkItem } from "./workLog";

const longPlan: WorkItem = { id: "p2", type: "proposed_plan", title: "Plan", detail: `# Big plan\n\n${Array.from({ length: 30 }, (_, index) => `- step ${index + 1}`).join("\n")}`, status: "completed" };
const saved = signal("");
const downloaded = signal("");

function Fixture() {
  return (
    <Scroll class="flex-1">
      <ProposedPlanCard
        item={() => longPlan}
        workspaceRoot={() => "/work/space"}
        request={async (method, payload) => { saved.set(JSON.stringify([method, payload])); return { relativePath: "big-plan.md" }; }}
        download={async (filename) => { downloaded.set(filename); return `/Downloads/${filename}`; }}
      />
      <ToastHost />
      <View>
        <Text>{`overlays: ${registeredOverlays().length}`}</Text>
        {saved() ? <Text>{saved()}</Text> : null}
        {downloaded() ? <Text>{`Downloaded ${downloaded()}`}</Text> : null}
      </View>
    </Scroll>
  );
}

mount(Fixture);
