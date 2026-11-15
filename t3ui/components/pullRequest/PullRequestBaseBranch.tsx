// The base branch, warning when the pull request has fallen behind it (PullRequestBaseBranch.tsx). The popover opens
// on hover (delay 0, closeDelay 120) or a press.
import { MiddleTruncate } from "../MiddleTruncate";
import { signal, Text, token, View } from "nsh";
import { createAnchor, hoverOpen, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import { holdLast, Presence } from "../motion/Motion";
import { DURATION_DEFAULT_MS } from "../motion/motionTokens";

export interface BaseFreshness { behindBy: number | null; methods: string[] }

export function baseFreshnessSummary(baseBranch: string, behindBy: number | null): string {
  const behind = behindBy === null ? "" : ` by ${behindBy.toLocaleString("en-US")} ${behindBy === 1 ? "commit" : "commits"}`;
  return `This branch is out-of-date with ${baseBranch}${behind}.`;
}

export function PullRequestBaseBranch(props: {
  baseBranch: string;
  freshness: BaseFreshness | null;
  stacked: boolean;
  pending: () => boolean;
  onUpdate: (method: string) => void;
}) {
  const open = signal(false);
  const anchor = createAnchor();
  const { hover, cancel } = hoverOpen((next) => open.set(next), { delay: 0, closeDelay: 120 });
  const label = (
    <>
      {props.stacked ? <View accessibilityLabel="Stacked pull request"><PRIcon name="layers" size={12} tint={props.freshness ? token("warning-foreground") : undefined} /></View> : null}
      <MiddleTruncate value={props.baseBranch} showTitle={false} textClass={`font-mono text-xs ${props.freshness ? "text-warning-foreground" : "text-muted-foreground"}`} />
    </>
  );
  const summary = () => baseFreshnessSummary(props.baseBranch, props.freshness?.behindBy ?? null);
  // The popup plays its 150ms exit after the freshness may have gone: it keeps showing the last one.
  const heldFreshness = holdLast(() => props.freshness);
  const heldSummary = () => baseFreshnessSummary(props.baseBranch, heldFreshness()?.behindBy ?? null);
  // The freshness arrives with the detail and changes after an update, so it is read in the JSX.
  return (
    <View class="max-w-[40%] min-w-0 shrink-0">
      {!props.freshness ? <View tooltip={props.stacked ? `Stacked on ${props.baseBranch}` : props.baseBranch} class="min-w-0 shrink-0 flex-row items-center gap-1">{label}</View> : null}
      {props.freshness ? <View ref={anchor.ref} role="button" accessibilityLabel={summary()} onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave} onPress={() => { cancel(); open.set(!open()); }} class="min-w-0 shrink-0 flex-row items-center gap-1">
        {label}
        <PRIcon name="triangle-alert" size={14} tint={token("warning-foreground")} />
      </View> : null}
      <Presence when={() => !!props.freshness && open()} ms={DURATION_DEFAULT_MS}>{(closing) => (
        <Popup animated closing={closing} anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="start" class="max-w-80">
          <View class="flex-col p-3" onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave}>
            <Text class="text-xs text-foreground">{heldSummary()}</Text>
            <Text class="mt-0.5 text-xs text-muted-foreground">Changes can be cleanly merged.</Text>
            {heldFreshness()!.methods.length > 0 ? (
              <View class="mt-2 flex-row flex-wrap items-center gap-1.5">
                <Each of={heldFreshness()!.methods} key={(method: string) => method}>
                  {(method) => (
                    <View
                      role="button"
                      accessibilityLabel={method() === "rebase" ? "Update with rebase" : "Update branch"}
                      onPress={() => { if (!props.pending()) { open.set(false); props.onUpdate(method()); } }}
                      class={props.pending() ? "h-6 flex-row items-center gap-1 rounded-md border border-border px-2 opacity-50" : "h-6 flex-row items-center gap-1 rounded-md border border-border px-2 hover:bg-accent-50"}
                    >
                      <PRIcon name="git-merge" size={12} />
                      <Text class="text-xs text-foreground">{method() === "rebase" ? "Update with rebase" : "Update branch"}</Text>
                    </View>
                  )}
                </Each>
              </View>
            ) : null}
          </View>
        </Popup>
      )}</Presence>
    </View>
  );
}

