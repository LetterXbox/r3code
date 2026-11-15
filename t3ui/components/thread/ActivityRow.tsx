import { Text, View } from "nsh";
import { Icon } from "../Icons";
import { chatWidthClass } from "./layout";
import type { ActivityItem } from "../../store";
import { ChevronTurn } from "../motion/Motion";

export type ActivityDisplay = Pick<ActivityItem, "id" | "type" | "title" | "detail" | "status">;

function activityIcon(type: string) {
  if (type === "file_change") return "file-diff";
  if (type === "file_search" || type === "web_search") return "search";
  if (type === "approval_request") return "shield-check";
  return "wrench";
}

export function ActivityRow(props: {
  item: () => ActivityDisplay;
  expanded: () => boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <View class={`mx-auto w-full px-6 py-1 ${chatWidthClass()}`}>
      <View class="rounded-lg border border-border bg-card">
        <View
          class="min-h-9 flex-row items-center gap-2 px-3 py-2"
          onPress={() => props.onToggle(props.item().id)}
          disabled={!props.item().detail}
          accessibilityLabel={`${props.expanded() ? "Collapse" : "Expand"} ${props.item().title}`}
          accessibilityState={{ expanded: props.expanded() }}
          role="button"
        >
          <Icon name={activityIcon(props.item().type)} size={15} />
          <Text class="min-w-0 flex-1 text-xs text-foreground">{props.item().title}</Text>
          <Text class="text-2xs text-muted-foreground">{props.item().status}</Text>
          {props.item().detail ? <ChevronTurn open={props.expanded} durationMs={200}><Icon name="chevron-right" size={14} /></ChevronTurn> : null}
        </View>
        {props.expanded() && props.item().detail ? (
          <View selectable class="border-t border-border px-3 py-2">
            <Text class={props.item().type === "command_execution" || props.item().type === "file_change" ? "font-mono text-xs text-muted-foreground" : "text-xs text-muted-foreground"}>{props.item().detail}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
