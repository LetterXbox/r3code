// MessagesTimeline.tsx's list header for a child thread: "Subagent of <title>" or "Context from <title>", opening the parent.
import { View } from "nsh";
import { chatWidthClass } from "../layout";
import { parentThreadLinkDetail, type ParentThreadLink } from "./parentThreadLink";
import { SystemDivider } from "./TimelineRows";

export function ThreadContextDivider(props: { link: () => ParentThreadLink }) {
  return (
    <View class={`mx-auto w-full ${chatWidthClass()} pt-1`} testID="Parent thread divider">
      <SystemDivider
        label={props.link().sideChat ? "Context from" : "Subagent of"}
        detail={parentThreadLinkDetail(props.link())}
        icon={props.link().sideChat ? "messages-square" : "bot"}
        {...(props.link().open ? { actionLabel: "Open parent thread", onAction: props.link().open } : {})}
      />
    </View>
  );
}
