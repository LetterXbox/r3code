// ThreadHoverCard.tsx + SidebarThreadTooltip (sidebar/SidebarThreadRow.tsx): the glass card a row opens
// on hover, right of it. The title in text-xs font-medium, then one icon row per fact in
// text-foreground/75: project, environment, branch, model, handed-off providers, terminal processes
// and an error line. No timestamp.
import { MiddleTruncate } from "../MiddleTruncate";
import { colorScheme, signal, Text, token, View } from "nsh";
import type { ViewProps } from "nsh";
import { Tooltip } from "nsh/base";
import { Icon } from "../Icons";
import type { Thread } from "../../store";
import { trackOpenChange } from "../rightPanel/nativeOcclusion";
import { FloatingRegion } from "../rightPanel/FloatingRegion";
import { ProjectTile } from "./ProjectTile";
import { Glyph } from "./SidebarGlyph";
import { mixColors } from "./mix";
import { backendUrl } from "../../store";
import { branchMismatch } from "./vcsBranch";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { machineKindForUrl } from "../thread/environmentOptions";
import { handedOffFrom, threadModelFact } from "./threadModel";

export const terminalProcessLabel = (count: number) => `${count} terminal ${count === 1 ? "process" : "processes"} running`;

function HoverRow(props: { icon: ViewProps["children"]; children: ViewProps["children"] }) {
  return (
    <View class="min-w-0 flex-row items-center gap-2">
      {props.icon}
      {props.children}
    </View>
  );
}

export function ThreadHoverCard(props: {
  thread: Thread;
  projectName?: string;
  terminalCount: number;
  /** The checked-out branch of the thread's checkout (useCheckoutBranch), for the branch mismatch line. */
  currentBranch?: () => string | null;
}) {
  const cardOpen = signal(false);
  const thread = () => props.thread;
  const environmentLabel = () => {
    const label = serverEnvironment()?.label;
    return typeof label === "string" && label.length > 0 ? label : null;
  };
  const model = () => threadModelFact(thread());
  // SidebarThreadRow: a local-checkout thread whose branch is not the one checked out says so (the row holds the
  // checkout's branch stream while it is mounted, as the web's row lease does; see useCheckoutBranch).
  const mismatch = () => branchMismatch({ worktreePath: thread().path ?? null, threadBranch: thread().meta?.branch ?? null, currentBranch: props.currentBranch?.() ?? null });
  const handedOff = () => handedOffFrom(thread());
  const body = () => {
    const scheme = colorScheme();
    const soft = mixColors(token("foreground"), token("popover"), 0.75);
    const error = thread().status === "stopped" && thread().error ? thread().error : null;
    const usageLimit = thread().meta?.lastErrorClass === "usage_limit";
    return (
      <View class="min-w-0 max-w-80 gap-2 px-1 py-2">
        <Text class="min-w-0 truncate text-xs font-medium leading-tight text-foreground">{thread().title}</Text>
        <View class="gap-1.5 pl-0.5">
          {props.projectName ? (
            <HoverRow icon={<ProjectTile name={props.projectName} projectId={thread().projectId} size={12} />}>
              <Text class="min-w-0 truncate text-xs" style={{ color: soft }}>{props.projectName}</Text>
            </HoverRow>
          ) : null}
          {environmentLabel() ? (
            <HoverRow icon={<Glyph name={machineKindForUrl(backendUrl()) === "laptop" ? "laptop" : "server"} size={12} tint={token("muted-foreground")} />}>
              <Text class="min-w-0 truncate text-xs" style={{ color: soft }}>{environmentLabel()}</Text>
            </HoverRow>
          ) : null}
          {thread().meta?.branch ? (
            <HoverRow icon={<Icon name="git-branch" size={12} tint={token("muted-foreground")} />}>
              <MiddleTruncate value={thread().meta!.branch!} textClass="text-xs" textStyle={{ color: soft }} />
            </HoverRow>
          ) : null}
          {mismatch() ? (
            <HoverRow icon={<Glyph name="circle-alert" size={12} tint={token("warning")} />}>
              <Text class="min-w-0 flex-1 text-xs text-warning">You're currently checked out on another branch.</Text>
            </HoverRow>
          ) : null}
          {model() ? (
            <HoverRow icon={<View style={{ opacity: 0.6, filter: "grayscale(1)" }}><ProviderIconView driver={model()!.driver} name={model()!.providerName} size={12} /></View>}>
              <Text class="min-w-0 truncate text-xs" style={{ color: soft }}>{model()!.label}</Text>
            </HoverRow>
          ) : null}
          {handedOff().length > 0 ? (
            <HoverRow icon={<Glyph name="arrow-right-left" size={12} tint={token("muted-foreground")} />}>
              <Text class="min-w-0 truncate text-xs" style={{ color: soft }}>{`Handed off from ${handedOff().join(", ")}`}</Text>
            </HoverRow>
          ) : null}
          {props.terminalCount > 0 ? (
            <HoverRow icon={<Glyph name="square-terminal" size={12} tint={scheme === "dark" ? "#5eead4" : "#0d9488"} />}>
              <Text class="min-w-0 truncate text-xs" style={{ color: soft }}>{terminalProcessLabel(props.terminalCount)}</Text>
            </HoverRow>
          ) : null}
          {error ? (
            <HoverRow icon={<Glyph name="circle-alert" size={12} tint={usageLimit ? token("warning") : token("error")} />}>
              <Text class={`min-w-0 truncate text-xs ${usageLimit ? "text-warning" : "text-error"}`}>
                {usageLimit ? "Usage limit reached" : "Error occurred"}
              </Text>
            </HoverRow>
          ) : null}
        </View>
      </View>
    );
  };
  return (
    <Tooltip placement="right" align="start" offset={4} onOpenChange={trackOpenChange(cardOpen)} class="max-w-80 rounded-md border border-border bg-popover-84 shadow-xl">
      {/* The reference's tooltip-popup wraps its content in a "tooltip-viewport" div (min-w-0 px-2 py-1)
          before the card's own px-1 py-2; without it the card sat flush against the popup edge. */}
      <FloatingRegion label="thread hover card"><View class="min-w-0 px-2 py-1">{body()}</View></FloatingRegion>
    </Tooltip>
  );
}
