// The loading skeletons, ported from PullRequestGhosts.tsx: the list rows, the detail panel (seeded from the
// list row when there is one), the people list, the timeline and the conversation. The web pulses them; these
// are still bars in the same places.
import { MiddleTruncate } from "../MiddleTruncate";
import { Text, View } from "nsh";
import { PRIcon } from "./PRIcon";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestDetailCrumbs } from "./PullRequestDetailCrumbs";
import { PullRequestChecksStatusLine, PullRequestDetailHeaderBody, PullRequestDetailTabBar, PullRequestDetailTitleRow } from "./PullRequestDetailLayout";
import { changeRequestTerm } from "./pullRequestCheckout.logic";
import { formatCount, relativeTime, resolveState, toneColor, type Scheme } from "./pullRequestPresentation";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";
import { loopStyle } from "../motion/Motion";
import { skeletonPulse } from "../motion/motionTokens";

export function GhostBar(props: { class?: string }) {
  return <View class={`h-3 rounded bg-muted ${props.class ?? ""}`} style={loopStyle(skeletonPulse)} />;
}

const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3"];
const DEFAULT_DETAIL_TABS = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

export function PullRequestListGhost(props: { rows?: number; caption?: string }) {
  const rows = Array.from({ length: props.rows ?? 7 }, (_, index) => index);
  return (
    <View class="flex-col gap-0.5" accessibilityLabel={props.caption ?? "Loading pull requests"}>
      {/* Outside the pulse so the explanation stays readable. */}
      {props.caption ? <Text class="px-3 pb-1 text-xs font-medium text-muted-foreground">{props.caption}</Text> : null}
      <View class="flex-col gap-0.5">
        <Each of={rows} key={(index: number) => index}>
          {(index) => (
            <View class="flex-row items-center gap-2 rounded-md px-3 py-2.5">
              <GhostBar class="size-4 rounded-full" />
              <View class="min-w-0 flex-1 flex-col gap-1.5">
                <GhostBar class={`h-4 ${TITLE_WIDTHS[index() % TITLE_WIDTHS.length]}`} />
                <GhostBar class={`h-3.5 ${META_WIDTHS[index() % META_WIDTHS.length]}`} />
              </View>
              <View class="flex-col items-end gap-1.5">
                <GhostBar class="w-12" />
                <GhostBar class="w-16" />
              </View>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

export interface DetailGhostSeed {
  provider: string; repository: string; number: number; url: string; title: string; author: { login: string; avatarUrl?: string } | null;
  updatedAt: string; baseBranch: string; headBranch: string; additions: number; deletions: number; state: string; isDraft: boolean;
  labels?: { name: string; color: string }[];
}

export function PullRequestDetailGhost(props: {
  seed: DetailGhostSeed | null;
  number?: number;
  now: () => number;
  scheme: () => Scheme;
  /** Replaces the header's actions while the real ones load. */
  actions?: unknown;
  onClose?: () => void;
  onOpen: (url: string) => void;
}) {
  const seed = () => props.seed;
  const state = () => (seed() ? resolveState({ state: seed()!.state, isDraft: seed()!.isDraft }) : null);
  return (
    <View class="min-h-0 flex-1 flex-col overflow-hidden bg-background" accessibilityLabel={`Loading ${seed() ? changeRequestTerm(seed()!.provider) : "pull request"}`}>
      <View class="shrink-0 flex-col border-b border-border-60">
        <View class="flex-row items-start gap-x-2">
          {seed() ? (
            <PullRequestDetailCrumbs detail={seed()} tone={state() ? toneColor(state()!.tone, props.scheme()) : null} repositoryUrl={null} onOpen={props.onOpen} />
          ) : (
            <View class="h-7 min-w-0 flex-1 flex-row items-center gap-1 pl-4"><GhostBar class="w-24" /><Text class="shrink-0 text-xs text-muted-foreground">{`#${props.number ?? "…"}`}</Text></View>
          )}
          <View class="mr-4 h-7 shrink-0 flex-row items-center justify-end gap-1">
            {(props.actions as never) ?? <GhostBar class="h-6 w-16 rounded-md" />}
            <View accessibilityLabel="Pull request actions loading" class="size-6 items-center justify-center opacity-50"><PRIcon name="chevron-down" size={14} /></View>
            {props.onClose ? <View role="button" accessibilityLabel="Collapse pull request panel" onPress={props.onClose} class="size-6 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"><PRIcon name="panel-right" size={14} /></View> : null}
          </View>
        </View>
        <PullRequestDetailHeaderBody
          title={<PullRequestDetailTitleRow>{seed() ? <Text class="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{seed()!.title}</Text> : <GhostBar class="h-5 w-4/5 max-w-md" />}</PullRequestDetailTitleRow>}
          author={seed() ? <PullRequestActorLabel actor={seed()!.author} /> : <View class="flex-row items-center gap-1.5"><GhostBar class="size-4 rounded-full" /><GhostBar class="w-14" /></View>}
          updated={seed() ? <Text class="text-xs text-muted-foreground">{`updated ${relativeTime(seed()!.updatedAt, props.now())}`}</Text> : <GhostBar class="w-16" />}
          base={seed() ? <MiddleTruncate value={seed()!.baseBranch} class="max-w-[40%] shrink-0" textClass="font-mono text-xs text-muted-foreground" /> : <GhostBar class="w-12" />}
          head={seed() ? <MiddleTruncate value={seed()!.headBranch} textClass="font-mono text-xs text-muted-foreground" /> : <GhostBar class="w-32 flex-1" />}
          files={"…"}
          diffStat={seed() ? <View class="flex-row items-baseline gap-1.5"><Text class={`font-mono text-xs ${diffAdditionClass("text-success")}`}>{`+${formatCount(seed()!.additions)}`}</Text><Text class={`font-mono text-xs ${diffDeletionClass("text-destructive")}`}>{`-${formatCount(seed()!.deletions)}`}</Text></View> : <GhostBar class="w-20" />}
        />
        <PullRequestDetailTabBar tabs={DEFAULT_DETAIL_TABS} value="summary" onValueChange={() => undefined}>
          <PullRequestChecksStatusLine icon={<GhostBar class="my-px size-3.5 rounded-full" />} label={<GhostBar class="w-28" />} />
        </PullRequestDetailTabBar>
      </View>
      <View class="min-h-0 flex-1 flex-col overflow-hidden">
        <View class="flex-col gap-2 px-4 pb-1 pt-2.5">
          <View class="min-h-6 min-w-0 flex-row items-center gap-2">
            <View class="w-24 flex-row items-center gap-1.5"><PRIcon name="users" size={14} /><Text class="text-xs text-muted-foreground">Reviewers</Text></View>
            <GhostBar class="w-10" />
            <View accessibilityLabel="Reviewers loading" accessibilityState={{ disabled: true }} class="size-6 items-center justify-center rounded-md opacity-50"><PRIcon name="user-plus" size={14} /></View>
          </View>
          <View class="min-h-6 min-w-0 flex-row items-center gap-2">
            <View class="w-24 flex-row items-center gap-1.5"><PRIcon name="tag" size={14} /><Text class="text-xs text-muted-foreground">Labels</Text></View>
            <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-1">
              {seed()?.labels ? (seed()!.labels!.length > 0 ? seed()!.labels!.map((label) => <Text class="rounded-full bg-secondary px-2 text-xs text-foreground">{label.name}</Text>) : <Text class="text-xs text-muted-foreground">None</Text>) : <><GhostBar class="h-4 w-24" /><GhostBar class="h-4 w-20" /></>}
              <View accessibilityLabel="Labels loading" accessibilityState={{ disabled: true }} class="size-6 items-center justify-center rounded-md opacity-50"><PRIcon name="tag" size={14} /></View>
            </View>
          </View>
        </View>
        <View class="flex-col">
          <View class="flex-row items-center gap-1.5 px-4 py-3"><Text class="text-xs font-medium text-muted-foreground">Description</Text><PRIcon name="chevron-down" size={14} /></View>
          <View class="flex-col gap-3 px-4 pb-4">
            <GhostBar class="h-5 w-40" />
            <View class="flex-col gap-2"><GhostBar class="h-4 w-full" /><GhostBar class="h-4 w-11/12" /><GhostBar class="h-4 w-4/5" /><GhostBar class="h-4 w-2/3" /></View>
          </View>
        </View>
      </View>
    </View>
  );
}

export function PullRequestPeopleGhost(props: { rows?: number }) {
  return (
    <View class="flex-col gap-1 p-1" accessibilityLabel="Loading people">
      <Each of={Array.from({ length: props.rows ?? 4 }, (_, index) => index)} key={(index: number) => index}>
        {(index) => <View class="h-7 flex-row items-center gap-2 rounded-md px-2"><GhostBar class="size-4 rounded-full" /><GhostBar class={META_WIDTHS[index() % META_WIDTHS.length]} /></View>}
      </Each>
    </View>
  );
}

export function PullRequestTimelineGhost(props: { rows?: number }) {
  return (
    <View class="px-4 py-5" accessibilityLabel="Loading timeline">
      <View class="ml-2 flex-col border-l border-border-60 pl-5">
        <Each of={Array.from({ length: props.rows ?? 6 }, (_, index) => index)} key={(index: number) => index}>
          {(index) => (
            <View class="relative pb-5">
              <GhostBar class="absolute left-[-26px] top-1 size-2 rounded-full" />
              <GhostBar class={`h-3.5 ${TITLE_WIDTHS[index() % TITLE_WIDTHS.length]}`} />
              <GhostBar class="mt-1.5 w-16" />
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

export function PullRequestConversationGhost(props: { rows?: number; term: string }) {
  return (
    <View class="flex-col gap-4 py-2" accessibilityLabel={`Loading ${props.term} conversation`}>
      <Each of={Array.from({ length: props.rows ?? 3 }, (_, index) => index)} key={(index: number) => index}>
        {(index) => (
          <View class="flex-row items-start gap-2">
            <GhostBar class="size-5 shrink-0 rounded-full" />
            <View class="flex-1 flex-col gap-1.5"><GhostBar class={META_WIDTHS[index() % META_WIDTHS.length]} /><GhostBar class="w-full" /><GhostBar class="w-3/4" /></View>
          </View>
        )}
      </Each>
    </View>
  );
}

