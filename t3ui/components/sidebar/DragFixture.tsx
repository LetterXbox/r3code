// Pinned, Active and Settled zones with one row each, wired as the sidebar wires them.
import { mount, signal, Text, View } from "nsh";
import { SidebarThreadRow } from "../SidebarThreadRow";
import { DragBoundary, DropHint, SidebarDragLayer, dragInsertion, draggingFrom, dropZone } from "./sidebarDrag";
import type { Thread } from "../../store";
import type { ThreadSidebarMeta } from "./threadMeta";

const meta = (patch: Partial<ThreadSidebarMeta>): ThreadSidebarMeta => ({
  runStatus: "idle", activityRunStatus: null, pendingRequestKind: null, pendingGuestMessageCount: 0,
  blockedOnThreadWait: false, lastErrorClass: null, lastVisitedAt: null, latestRunCompletedAt: null,
  latestRunStartedAt: null, snoozedUntil: null, settled: false, hasActionableProposedPlan: false,
  branch: null, titleRegenerating: false, ...patch,
});
const make = (id: string, title: string, extra: Partial<Thread> = {}, patch: Partial<ThreadSidebarMeta> = {}): Thread => ({
  id, projectId: "p", title, status: "idle", pinned: false, updatedAt: Date.now() - 5 * 60_000, meta: meta(patch), ...extra,
});

const dropped = signal("none");
const note = (id: string) => (verb: string, to: string) => dropped.set(`${id} ${verb} ${to}`);

function Fixture() {
  return (
    <View class="w-[300px] bg-sidebar p-2">
      <View class="gap-px" {...dropZone("pinned")}>
        <DragBoundary section="pinned" label="Pinned" />
        <SidebarThreadRow thread={make("pin", "Pinned one", { pinned: true })} variant="card" active={false} projectName="Demo" dragEnabled={() => true} onDrop={note("pin")} onPress={() => {}} />
      </View>
      <View class="gap-px" {...dropZone("active")}>
        <DragBoundary section="active" label="Active" />
        <SidebarThreadRow thread={make("act", "Active one")} variant="card" active={false} projectName="Demo" dragEnabled={() => true} onDrop={note("act")} onPress={() => {}} />
      </View>
      <View class="gap-px" {...dropZone("settled")}>
        <Text>Settled shelf</Text>
        <DropHint section="settled" label="Settled" show={false} />
        <SidebarThreadRow thread={make("set", "Settled one", {}, { settled: true })} variant="slim" active={false} projectName="Demo" dragEnabled={() => true} onDrop={note("set")} onPress={() => {}} />
      </View>
      <Text>{draggingFrom() ? `Dragging from ${draggingFrom()}` : "Idle"}</Text>
      <Text>Dropped: {dropped()}</Text>
      <Text>{`Insertion: ${JSON.stringify(dragInsertion())}`}</Text>
      <SidebarDragLayer />
    </View>
  );
}

mount(Fixture);
