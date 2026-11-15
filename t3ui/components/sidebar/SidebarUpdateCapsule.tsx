// SidebarUpdateCapsule.tsx: while an "Update everything" run is going (or ended with a failure), the footer shows this
// capsule in place of the round button: a label (describeUpdateCapsule), a Dismiss link once a failure settled, otherwise the
// run's status icon, and a popup (top, end) listing each machine with its status, elapsed time and failure text.
import { signal, token, Text, View } from "nsh";
import { Popover } from "nsh/base";
import { trackOpenChange, useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { Glyph } from "./SidebarGlyph";
import { describeUpdateCapsule, formatUpdateElapsed, RUN_STATUS_LABELS, runMachineFailure, runMachineStatus, type UpdateEverythingRun } from "./updateCapsule";

export function SidebarUpdateCapsule(props: { run: UpdateEverythingRun; now: () => number; onDismiss: () => void }) {
  const open = signal(false);
  useOverlayOpen(open, "sidebar update capsule");
  const view = () => describeUpdateCapsule(props.run, props.now());
  const status = () => runMachineStatus(props.run.machine);
  const failure = () => runMachineFailure(props.run.machine);
  const label = () => (view().slow ? `${view().label} ${view().slow!.status} ${view().slow!.elapsed}` : view().label);
  return (
    <View testID="Sidebar update capsule" class="h-8 min-w-0 flex-1 flex-row items-center rounded-full bg-sidebar-control-surface">
      <Popover
        open={open()}
        onOpenChange={trackOpenChange(open)}
        placement="top"
        align="end"
        offset={6}
        popupClass="w-72 gap-1 rounded-lg border border-border bg-popover-84 p-2"
        trigger={
          <View role="button" accessibilityLabel={label()} class="h-8 min-w-0 flex-1 justify-center rounded-full pl-3 hover:bg-sidebar-row-hover">
            <View class="min-w-0 flex-row items-center">
              <Text class={view().tone === "failed" ? "min-w-0 truncate text-xs text-destructive" : "min-w-0 truncate text-xs text-sidebar-foreground"}>{view().label}</Text>
              {view().slow ? <Text class="shrink-0 text-xs text-warning">{` ${view().slow!.elapsed}`}</Text> : null}
            </View>
          </View>
        }
      >
        <View class="gap-1">
          <View class="min-w-0 gap-0">
            <View class="flex-row items-center justify-between gap-3">
              <Text class="min-w-0 flex-1 truncate text-xs text-popover-foreground">{props.run.machine.label}</Text>
              <Text class={status() === "failed" ? "shrink-0 text-xs text-destructive" : "shrink-0 text-xs text-muted-foreground"}>
                {`${RUN_STATUS_LABELS[status()]}${status() === "providers" ? ` ${formatUpdateElapsed(props.now() - props.run.startedAt)}` : ""}`}
              </Text>
            </View>
            {failure() ? <Text class="text-xs text-muted-foreground">{failure()}</Text> : null}
          </View>
          {status() === "failed" ? (
            <View class="mt-1 flex-row justify-end gap-1">
              <View role="button" accessibilityLabel="Dismiss" class="h-6 items-center justify-center rounded-md px-2 hover:bg-accent" onPress={props.onDismiss}>
                <Text class="text-xs font-medium text-foreground">Dismiss</Text>
              </View>
            </View>
          ) : null}
        </View>
      </Popover>
      {view().action !== null ? (
        <View role="button" accessibilityLabel="Dismiss" class="shrink-0 pl-1.5 pr-3" onPress={props.onDismiss}>
          <Text class="text-xs text-sidebar-foreground underline">Dismiss</Text>
        </View>
      ) : (
        <View class="size-8 shrink-0 items-center justify-center">
          <Glyph name="circle-arrow-up" size={16} tint={token("sidebar-foreground")} />
        </View>
      )}
    </View>
  );
}
