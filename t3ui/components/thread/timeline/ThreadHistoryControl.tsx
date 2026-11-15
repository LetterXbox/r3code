// MessagesTimeline.tsx TimelineHistoryControl: at the top of a paged thread, "Load earlier turns" between two rules
// ("Loading earlier turns..." while it pages), and the failure as a status line under it.
import { Text, View } from "nsh";
import { createHover } from "../../hoverReveal";
import { chatWidthClass } from "../layout";
import type { ThreadHistoryState } from "../../../store";

export function ThreadHistoryControl(props: { history: () => ThreadHistoryState; onLoadEarlier: () => void }) {
  const hover = createHover();
  const shown = () => props.history().hasMore || props.history().error !== null;
  return (
    <>
      {shown() ? (
        <View class={`mx-auto w-full ${chatWidthClass()} gap-1.5 pb-2`}>
          {props.history().hasMore ? (
            <View
              class="w-full flex-row items-center gap-3 py-1.5"
              role="button"
              accessibilityLabel="Load earlier turns"
              disabled={props.history().loading}
              onPress={() => { if (!props.history().loading) props.onLoadEarlier(); }}
              {...hover.bind}
            >
              <View class="h-px flex-1 bg-border-70" />
              <Text class={`shrink-0 text-xs ${hover.hovered() && !props.history().loading ? "text-foreground" : "text-muted-foreground"}`}>
                {props.history().loading ? "Loading earlier turns…" : "Load earlier turns"}
              </Text>
              <View class="h-px flex-1 bg-border-70" />
            </View>
          ) : null}
          {props.history().error !== null ? (
            <Text class="text-center text-xs text-muted-foreground" accessibilityLabel={props.history().error ?? undefined}>{props.history().error}</Text>
          ) : null}
        </View>
      ) : null}
    </>
  );
}
