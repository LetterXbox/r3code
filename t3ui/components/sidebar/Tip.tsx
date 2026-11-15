import { Text } from "nsh";
import { Tooltip } from "nsh/base";

/** The small label tooltip the sidebar's icon buttons share. `delay`: the thread list's TooltipProvider opens its
 * tooltips after 150 ms (Sidebar.tsx:3235-3238, 3312-3316); elsewhere the default. */
export const THREAD_LIST_TOOLTIP_DELAY_MS = 150;
export function Tip(props: { label: string; delay?: number }) {
  return (
    <Tooltip placement="top" {...(props.delay !== undefined ? { delay: props.delay } : {})} class="rounded-md border border-border bg-popover px-2 py-1">
      <Text class="text-xs text-popover-foreground">{props.label}</Text>
    </Tooltip>
  );
}
