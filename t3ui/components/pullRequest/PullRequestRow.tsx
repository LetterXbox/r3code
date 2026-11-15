import githubMark from "../palette/icons/source-github.svg";
import gitlabMark from "../palette/icons/source-gitlab.svg";
// One list row, ported from PullRequestRow.tsx + PullRequestListRow.tsx:
// state glyph (conflict badge on its corner), #number, title, checks and review glyphs,
// +/- stat, then author, repository, labels and the updated time.
import { cleanup, Image, openUrl, Text, View } from "nsh";
import type { ViewRef } from "nsh";
import { registerSweepRow } from "./pullRequestCloseSweep";
import { requestBackend, settingValue } from "../../store";
import type { PullRequestEntry } from "../../pages/utility-data";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import { PRIcon } from "./PRIcon";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import { PullRequestSpeedActions } from "./PullRequestSpeedActions";
import { openChecksKey, toggleChecks } from "./pullRequestChecksStore";
import { entryKey } from "./pullRequestList.logic";
import { createPullRequestRowIntent } from "./pullRequestRowIntent";
import {
  formatCount, pullRequestLabelColor, relativeTime, resolveChecksState, resolveConflict, resolveReviewDecision, resolveState,
  toneColor, type Scheme,
} from "./pullRequestPresentation";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";

function scheme(): Scheme {
  return settingValue("colorScheme") === "light" ? "light" : "dark";
}

function LabelChip(props: { name: string; color: string; extra?: number }) {
  const color = pullRequestLabelColor(props.color);
  return (
    <View
      class={color ? "min-w-0 max-w-40 shrink flex-row items-center gap-1 rounded-full border px-1.5" : "min-w-0 max-w-40 shrink flex-row items-center gap-1 rounded-full bg-secondary px-1.5"}
      style={color ? { borderColor: `${color}66`, backgroundColor: `${color}1f` } : undefined}
    >
      <Text class="shrink truncate text-2xs text-foreground">{props.name}</Text>
      {props.extra ? <Text class="shrink-0 text-2xs text-muted-foreground">{`+${props.extra}`}</Text> : null}
    </View>
  );
}

export function PullRequestRow(props: { entry: PullRequestEntry; selected: () => boolean; now: () => number; onSelect: (entry: PullRequestEntry) => void; showProject: boolean; request?: (method: string, payload: unknown) => Promise<unknown>; hostActions?: () => ReadonlySet<string>; onActed?: () => void; onIntent?: (entry: PullRequestEntry | null) => void; matchedElsewhere?: boolean; onActionDone?: (entry: PullRequestEntry, action: string) => void; /** The group the row is listed under (close sweeps stay in one group). */ groupKey?: string }) {
  const entry = props.entry;
  const state = resolveState(entry);
  const conflict = resolveConflict(entry);
  const checks = resolveChecksState(entry.checksState);
  const review = resolveReviewDecision(entry.reviewDecision);
  const labels = entry.labels.slice(0, 3);
  const hasStat = entry.additions + entry.deletions > 0;
  const intent = createPullRequestRowIntent(entry, (row) => props.onIntent?.(row));
  let unregister: (() => void) | undefined;
  cleanup(() => unregister?.());
  return (
    <View class="flex-col" ref={(node: ViewRef) => { unregister?.(); unregister = props.groupKey !== undefined && props.hostActions ? registerSweepRow(entryKey(entry), { node, entry, groupKey: props.groupKey, canClose: () => props.hostActions!().has("close") }) : undefined; }}>
    <View
      role="button"
      focusable
      accessibilityLabel={`Open pull request ${entry.repository} #${entry.number}`}
      onPress={() => props.onSelect(entry)}
      onMouseEnter={intent.enter}
      onMouseLeave={intent.leave}
      onFocus={intent.focus}
      onBlur={intent.blur}
      class={props.selected() ? "flex-row items-center gap-2 rounded-md bg-accent px-3 py-2.5" : "flex-row items-center gap-2 rounded-md px-3 py-2.5 hover:bg-accent-50 transition-colors duration-150 ease-in-out"}
    >
      <View class="relative w-4 shrink-0 self-start pt-0.5">
        <PRIcon name={state.icon} size={16} tint={toneColor(state.tone, scheme())} />
        {conflict ? <View class="absolute -bottom-1 -right-1"><PRIcon name={conflict.icon} size={12} tint={toneColor(conflict.tone, scheme())} /></View> : null}
      </View>
      <View class="min-w-0 flex-1 flex-col gap-0.5">
        <View class="min-w-0 flex-row items-center gap-1.5">
          <Text class="shrink-0 font-mono text-xs text-muted-foreground">{`#${entry.number}`}</Text>
          <Text class="min-w-0 shrink truncate text-sm text-foreground">{entry.title}</Text>
          {checks ? (
            <View accessibilityLabel={`Checks: ${checks.label}`} role="button" onPress={() => void toggleChecks(entry, props.request ?? requestBackend)} class="shrink-0">
              <PRIcon name={checks.icon} size={14} tint={toneColor(checks.tone, scheme())} />
            </View>
          ) : null}
          {review ? <PRIcon name={review.icon} size={14} tint={toneColor(review.tone, scheme())} /> : null}
          <View class="flex-1" />
          {entry.stack ? <PullRequestStackPopover reference={{ projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number }} membership={entry.stack} request={props.request ?? requestBackend} onSelect={(number) => props.onSelect({ ...entry, number, url: entry.url.replace(/\/\d+$/u, `/${number}`) })} /> : null}
          {hasStat ? <PullRequestChangeBreakdownStat size="2xs" reference={{ projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number }} additions={entry.additions} deletions={entry.deletions} request={props.request ?? requestBackend} /> : null}
        </View>
        <View class="min-w-0 flex-row items-center gap-1.5">
          <Image src={entry.provider === "gitlab" ? gitlabMark : githubMark} style={{ width: 12, height: 12 }} />
          <View class="max-w-40 min-w-0 shrink flex-row items-center gap-1">
            {entry.authorAvatarUrl ? (
              <View class="size-3.5 shrink-0 overflow-hidden rounded-full"><Image src={entry.authorAvatarUrl} style={{ width: 14, height: 14 }} /></View>
            ) : null}
            <Text class="shrink truncate text-2xs text-muted-foreground">{entry.author || "ghost"}</Text>
          </View>
          {props.showProject ? <Text class="shrink truncate text-2xs text-muted-foreground">{entry.repository}</Text> : null}
          {props.matchedElsewhere ? (
            <View accessibilityLabel="matched in the description" tooltip="Matched in the description" class="min-w-6 shrink flex-row items-center gap-1 overflow-hidden rounded-full border border-border-60 px-1">
              <PRIcon name="search" size={12} />
              <Text class="truncate text-3xs text-muted-foreground">matched in the description</Text>
            </View>
          ) : null}
          {labels.map((label, index) => (
            <LabelChip name={label.name} color={label.color} extra={index === labels.length - 1 ? entry.labels.length - labels.length : 0} />
          ))}
          <View class="flex-1" />
          <Text class="shrink-0 text-2xs text-muted-foreground">{relativeTime(entry.updatedAt, props.now())}</Text>
        </View>
      </View>
      {props.hostActions && props.request ? <PullRequestSpeedActions entry={entry} hostActions={props.hostActions} request={props.request} term={entry.provider === "gitlab" ? "merge request" : "pull request"} {...(props.onActed ? { onActed: props.onActed } : {})} {...(props.groupKey !== undefined ? { sweep: { key: entryKey(entry) } } : {})} {...(props.onActionDone ? { onActionDone: props.onActionDone } : {})} /> : null}
    </View>
    {openChecksKey() === entryKey(entry) ? <PullRequestChecksPopover entryKey={entryKey(entry)} scheme={scheme} onOpenLink={(url) => void openUrl(url).catch(() => undefined)} /> : null}
    </View>
  );
}

