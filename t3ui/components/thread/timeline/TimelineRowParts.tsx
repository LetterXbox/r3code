// TimelineRowParts.tsx: the day-aware timestamp a row shows at its right edge while it is hovered or focused
// (TimelineRowTimestamp), with the full date as its tooltip. The reference reveals it with the row's `group`
// class; `group-hover:`/`group-focus-within:` do not reach a descendant on this runtime's GPUI host
// (workspace/nsh-runtime-bugs.md), so the row tracks its own hover/focus with `createHover()` and passes
// the result in as `hovered`.
import { Text } from "nsh";
import { settingValue } from "../../../store";
import { asTimestampFormat, formatChatTimestampTooltip, formatDayAwareTimestamp } from "../timestampFormat";

export function TimelineRowTimestamp(props: { createdAt: () => number | undefined; hovered: () => boolean; alwaysVisible?: boolean }) {
  const format = () => asTimestampFormat(settingValue("timestampFormat"));
  const stamp = () => formatDayAwareTimestamp(props.createdAt() ?? 0, format());
  return stamp() ? (
    <Text
      class={`me-1 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground ${props.alwaysVisible || props.hovered() ? "opacity-100" : "opacity-0"}`}
      tooltip={formatChatTimestampTooltip(props.createdAt() ?? 0, format())}
    >
      {stamp()}
    </Text>
  ) : null;
}
