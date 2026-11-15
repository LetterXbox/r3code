// Dragging a thread between Pinned, Active and the Settled shelf. The web uses dnd-kit; NSH has
// no drag and drop, only pans, so a row reports its pan, the zones report where they are
// (measure), and while the pan is on a window-sized overlay follows the pointer so the destination
// lights up live. A pan's own travel settles the drop where the pointer was never seen.
import { Overlay, signal, Text, token, View } from "nsh";
import type { MouseEvent as NshMouseEvent, PanEvent, ViewRef } from "nsh";
import { Glyph } from "./SidebarGlyph";
import type { GlyphName } from "./SidebarGlyph";
import { mixColors } from "./mix";
import { DROP_VERB_LABEL, insertionIndex, resolveSidebarDropVerb, sectionAtY } from "./sidebarDrop";
import type { DragSection, DropVerb, DropZoneBounds } from "./sidebarDrop";
import { createStepReveal } from "./stepReveal";
import { dropThreadOnComposer, moveThreadDrag, primeThreadDrop } from "../files/fileTreeDragMention";
import { usageEnvironments } from "../../store";

interface ActiveDrag {
  id: string;
  title: string;
  from: DragSection;
  y: number;
  x: number;
  /** The overlay has reported the pointer, so its position beats the pan's travel. */
  followed: boolean;
  onDrop: (verb: DropVerb, to: DragSection) => void;
  /** A drop inside Pinned or Active: the slot among the other rows, 0 for the top. */
  onReorder?: (section: "pinned" | "active", index: number) => void;
  /** The dragged row's height, for the gap that opens where it would land. */
  height: number;
  /** The rows of Pinned and Active as they stood when the drag began, top to bottom. */
  slots: Slot[];
  ready: Promise<void>;
}

interface Slot { id: string; section: DragSection; center: number }

const active = signal<ActiveDrag | null>(null);
const zoneBounds = signal<DropZoneBounds[]>([]);
const zoneRefs = new Map<DragSection, ViewRef>();
const rowRefs = new Map<string, { section: () => DragSection; node: ViewRef }>();

/** A row that can be reordered tells the drag where it is (its ref callback). */
export function registerDragRow(id: string, section: () => DragSection, node: ViewRef | null) {
  if (node) rowRefs.set(id, { section, node });
  else rowRefs.delete(id);
}

const REORDERABLE: readonly DragSection[] = ["pinned", "active"];

/** The Pinned and Active rows' centres, measured once at the start of a drag. */
async function measureSlots(): Promise<Slot[]> {
  const found = await Promise.all([...rowRefs].map(async ([id, row]) => {
    const section = row.section();
    if (!REORDERABLE.includes(section)) return null;
    const measured = await row.node.measure();
    return measured ? { id, section, center: measured.pagePosition.y + measured.bounds.size.height / 2 } : null;
  }));
  return found.filter((slot): slot is Slot => slot !== null).sort((a, b) => a.center - b.center);
}

/** Where the dragged row would land among the others of the section it is over, or null. */
export function dragInsertion(): { section: "pinned" | "active"; index: number; peers: string[] } | null {
  const current = active();
  const target = dragTargetSection();
  if (!current || (target !== "pinned" && target !== "active")) return null;
  const peers = current.slots.filter((slot) => slot.section === target && slot.id !== current.id);
  const index = insertionIndex(peers.map((slot) => slot.center), current.y);
  return { section: target, index, peers: peers.map((slot) => slot.id) };
}

/** The row the gap opens above, while a drag is over its section. */
export const dragGapBefore = (id: string): boolean => {
  const insertion = dragInsertion();
  return insertion !== null && insertion.peers[insertion.index] === id && active()?.id !== id;
};

/** Whether the gap opens below the last row of a section. */
export const dragGapAtEnd = (section: "pinned" | "active"): boolean => {
  const insertion = dragInsertion();
  return insertion !== null && insertion.section === section && insertion.index === insertion.peers.length;
};

/** SidebarThreadRow's open slot: a dashed outline the height of the dragged row. */
export function DragGap() {
  return (
    <View
      accessibilityLabel="Drop position"
      class="mx-0.5 rounded-md border border-dashed"
      style={{
        height: Math.max(active()?.height ?? 36, 24),
        borderColor: mixColors(token("primary"), token("sidebar"), 0.4),
        backgroundColor: mixColors(token("primary"), token("sidebar"), 0.05),
      }}
    />
  );
}
let lastPointer = { x: 0, y: 0 };

async function measureZones() {
  const measured = await Promise.all([...zoneRefs].map(async ([section, node]) => {
    const found = await node.measure();
    return found ? { section, top: found.pagePosition.y, bottom: found.pagePosition.y + found.bounds.size.height } : null;
  }));
  zoneBounds.set(measured.filter((zone): zone is DropZoneBounds => zone !== null));
}

/** The section the dragged row is over, or null. */
export const dragTargetSection = (): DragSection | null => {
  const current = active();
  return current ? sectionAtY(zoneBounds(), current.y) : null;
};

/** The section the dragged row came from, or null when nothing is being dragged. */
export const draggingFrom = (): DragSection | null => active()?.from ?? null;

export const isDraggingThread = (id: string) => active()?.id === id;

/** What dropping the dragged row here would do. */
export const dragVerb = (): DropVerb | null => {
  const current = active();
  return current ? resolveSidebarDropVerb(current.from, dragTargetSection()) : null;
};

/** Spread on the view that holds a section's rows. */
export function dropZone(section: DragSection) {
  return {
    ref: (node: ViewRef | null) => {
      if (node) zoneRefs.set(section, node);
      else zoneRefs.delete(section);
    },
  };
}

function finish(finalY: number, finalX: number) {
  const drag = active();
  if (!drag) return;
  active.set(null);
  // threadContextDrag.ts dropThreadContext: released over the composer, the thread becomes prompt context instead.
  if (dropThreadOnComposer({ x: finalX, y: finalY }, { id: drag.id, title: drag.title }, usageEnvironments()[0]?.id)) return;
  const target = sectionAtY(zoneBounds(), finalY);
  if (target !== null && target === drag.from && (target === "pinned" || target === "active") && drag.onReorder) {
    const peers = drag.slots.filter((slot) => slot.section === target && slot.id !== drag.id);
    drag.onReorder(target, insertionIndex(peers.map((slot) => slot.center), finalY));
    return;
  }
  const verb = resolveSidebarDropVerb(drag.from, target);
  if (verb && target) drag.onDrop(verb, target);
}

export interface ThreadDragInput {
  id: () => string;
  title: () => string;
  from: () => DragSection;
  enabled: () => boolean;
  onDrop: (verb: DropVerb, to: DragSection) => void;
  /** A drop inside Pinned or Active, at a slot among the other rows. */
  onReorder?: (section: "pinned" | "active", index: number) => void;
  /** The row's own view, to start the drag from its middle. */
  row: () => ViewRef | null;
}

/** Spread on a row's pressable view. */
export function threadDragHandlers(input: ThreadDragInput) {
  let startY = 0;
  let startX = 0;
  return {
    onMouseMove: (event: NshMouseEvent) => {
      lastPointer = { x: event.pagePosition.x, y: event.pagePosition.y };
    },
    onPanStart: () => {
      if (!input.enabled()) return;
      startY = lastPointer.y;
      startX = lastPointer.x;
      primeThreadDrop();
      const row = input.row();
      const ready = (async () => {
        const found = await row?.measure();
        if (found) startY = found.pagePosition.y + found.bounds.size.height / 2;
        const current = active();
        if (current && !current.followed) active.set({ ...current, y: startY, height: found?.bounds.size.height ?? current.height });
        await measureZones();
        const slots = await measureSlots();
        const latest = active();
        if (latest) active.set({ ...latest, slots });
        // The hints that open while dragging move the zones; measure again once they are in.
        setTimeout(() => { void measureZones(); }, 40);
      })();
      active.set({
        id: input.id(), title: input.title(), from: input.from(), y: startY, x: lastPointer.x,
        followed: false, onDrop: input.onDrop, onReorder: input.onReorder, height: 36, slots: [], ready,
      });
    },
    onPanEnd: async (event: PanEvent) => {
      const drag = active();
      if (!drag || drag.id !== input.id()) return;
      if (event.cancelled) {
        active.set(null);
        return;
      }
      await drag.ready;
      const current = active();
      if (!current) return;
      finish(current.followed ? current.y : startY + event.translation.y, current.followed ? current.x : startX + event.translation.x);
    },
  };
}

function follow(event: NshMouseEvent) {
  const current = active();
  if (!current) return;
  // The button came up somewhere the pan did not report: the drag is over.
  if (event.pressedButton === null && current.followed) {
    finish(current.y, current.x);
    return;
  }
  moveThreadDrag({ x: event.pagePosition.x, y: event.pagePosition.y });
  active.set({ ...current, y: event.pagePosition.y, x: event.pagePosition.x, followed: true });
}

const VERB_GLYPH: Record<DropVerb, GlyphName> = {
  pin: "pin",
  unpin: "pin-off",
  settle: "circle-check",
  unsettle: "undo-2",
  wake: "alarm-clock-off",
};

/** The destination chip on the dragged row: "Pin", "Settle", ... (dropVerbBadge). */
export function DropVerbBadge(props: { verb: DropVerb }) {
  return (
    <View
      accessibilityLabel={`Drop to ${DROP_VERB_LABEL[props.verb]}`}
      class="h-5 flex-row items-center gap-1 rounded-sm border px-1.5"
      style={{
        borderColor: mixColors(token("primary"), token("sidebar"), 0.4),
        backgroundColor: mixColors(token("primary"), token("sidebar"), 0.1),
      }}
    >
      <Glyph name={VERB_GLYPH[props.verb]} size={12} tint={token("primary")} />
      <Text class="text-2xs font-medium" style={{ color: token("primary") }}>{DROP_VERB_LABEL[props.verb]}</Text>
    </View>
  );
}

/** SidebarSectionPlaceholder: a dashed box that opens in an empty section while a row is dragged. */
export function DropHint(props: { section: DragSection; label: string; show: boolean }) {
  const target = () => dragTargetSection() === props.section;
  return <>{props.show ? (
    <View
      accessibilityLabel={`Drop here: ${props.label}`}
      class="mx-0.5 h-9 items-center justify-center rounded-md border border-dashed"
      style={{
        borderColor: target() ? mixColors(token("primary"), token("sidebar"), 0.4) : mixColors(token("sidebar-foreground"), token("sidebar"), 0.25),
        backgroundColor: target() ? mixColors(token("primary"), token("sidebar"), 0.05) : "transparent",
      }}
    >
      <Text class="text-xs" style={{ color: target() ? token("primary") : mixColors(token("sidebar-foreground"), token("sidebar"), 0.8) }}>
        {props.label}
      </Text>
    </View>
  ) : null}</>;
}

/** SidebarDragBoundary: the "Pinned" / "Active" label and rule that show while a row is dragged. */
export function DragBoundary(props: { section: "pinned" | "active"; label: string }) {
  const target = () => dragTargetSection() === props.section;
  // sidebar-drag-label-reveal: hidden for the first 200ms of a pickup (its space is kept), then shown at once.
  const revealed = createStepReveal(() => draggingFrom() !== null);
  return <>{draggingFrom() !== null ? (
    <View class="mx-2 mt-1 h-4 flex-row items-center gap-2" style={{ opacity: revealed() ? 1 : 0 }} testID="Drag boundary label">
      <Text class="text-xs font-medium" style={{ color: target() ? token("primary") : mixColors(token("sidebar-foreground"), token("sidebar"), 0.8) }}>
        {props.label}
      </Text>
      <View
        class="h-px flex-1"
        style={{ backgroundColor: target() ? mixColors(token("primary"), token("sidebar"), 0.5) : mixColors(token("sidebar-foreground"), token("sidebar"), 0.25) }}
      />
    </View>
  ) : null}</>;
}

/** Rendered once by the sidebar: the pointer listener and the floating label while a row is dragged. */
export function SidebarDragLayer() {
  return <>{active() === null ? null : (
    <Overlay class="inset-0 z-50" accessibilityLabel="Dragging thread" style={{ cursor: "grabbing" }} onMouseMove={follow}>
      <View
        class="absolute h-7 max-w-[220px] flex-row items-center rounded-md border border-border bg-popover px-2"
        style={{ left: (active()?.x ?? 0) + 12, top: (active()?.y ?? 0) - 14, pointerEvents: "none" }}
      >
        <Text class="truncate text-sm font-medium text-popover-foreground">{active()?.title ?? ""}</Text>
      </View>
    </Overlay>
  )}</>;
}
