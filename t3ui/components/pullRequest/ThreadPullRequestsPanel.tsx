// The thread's linked pull requests (ThreadPullRequestsPanel.tsx): a row for each link with its state, number (the source and
// time on hover), title, signals, author and branches, an actions menu (Copy link, Open, Watch, Unlink or Dismiss), and a
// footer with the counts and Link. An empty thread offers Link pull request.
import { MiddleTruncate } from "../MiddleTruncate";
import { Clipboard, colorScheme, Scroll, signal, Text, View } from "nsh";
import type { LinkedPullRequest } from "../header/threadRelations";
import { createAnchor, Popup } from "../composer/Popover";
import { showToast } from "../toast";
import { pullRequestsSupported } from "./pullRequestsSupported";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { PRIcon } from "./PRIcon";
import { Tip } from "../../pages/settings/providers/ui";
import { relativeTime, resolveChecksState, resolveReviewDecision, resolveState, toneColor } from "./pullRequestPresentation";
import { isOpenLink, LINK_SOURCE_LABELS, threadPullRequestsSummary, unlinkCommand, unlinkMenuLabel, visibleThreadPullRequests, watchCommand } from "./threadPullRequests.logic";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";
import { pullRequestDragHandlers } from "../files/fileTreeDragMention";

export interface ThreadPullRequestsPanelProps {
  threadId: string;
  links: () => LinkedPullRequest[];
  now: () => number;
  /** The orchestration command dispatcher (orchestration.dispatchCommand with a fresh commandId). */
  dispatch: (command: Record<string, unknown>) => Promise<unknown>;
  onOpen: (link: LinkedPullRequest) => void;
  onLink: () => void;
  /** The environment can watch (capabilities.threadPullRequestWatch); absent hides Watch. */
  supportsWatch?: boolean;
  /** Whether the environment has delivered its server config; defaults to the Pull requests entry's own rule. */
  supported?: () => boolean;
}

function MenuRow(props: { label: string; icon: string; onPress: () => void }) {
  return <View role="button" accessibilityLabel={props.label} onPress={props.onPress} class="h-8 flex-row items-center gap-2 rounded-sm px-2 hover:bg-accent-50">
    <PRIcon name={props.icon} size={14} /><Text class="text-sm text-foreground">{props.label}</Text>
  </View>;
}

function LinkRow(props: { link: LinkedPullRequest; panel: ThreadPullRequestsPanelProps; speed: () => boolean }) {
  const link = () => props.link;
  const menuOpen = signal(false);
  const anchor = createAnchor();
  const snapshot = () => link().snapshot;
  const state = () => resolveState({ state: snapshot()?.state ?? "open", isDraft: snapshot()?.isDraft ?? false });
  const checks = () => (snapshot()?.checksState ? resolveChecksState(snapshot()!.checksState as string) : null);
  const review = () => (snapshot()?.reviewDecision ? resolveReviewDecision(snapshot()!.reviewDecision as string) : null);
  const title = () => snapshot()?.title ?? link().repository;
  // composerMentionDrag: dragging the row onto the composer attaches it as pull request context (once the host reported it).
  const drag = pullRequestDragHandlers(() => {
    const snap = snapshot();
    if (!snap) return null;
    return { number: link().number, title: snap.title, url: link().url, headBranch: snap.headBranch, baseBranch: snap.baseBranch, state: snap.state === "merged" || snap.state === "closed" ? snap.state : "open", isDraft: snap.isDraft };
  });
  const run = async (work: () => Promise<unknown>, failure: string) => {
    menuOpen.set(false);
    try { await work(); } catch (cause) { showToast({ type: "error", title: failure, description: cause instanceof Error ? cause.message : String(cause) }); }
  };
  return (
    <View class="relative min-h-11 flex-row items-center gap-2 rounded-md px-2 py-1 hover:bg-accent-50" accessibilityLabel={`Linked pull request #${link().number}`} onContextMenu={() => menuOpen.set(true)}>
      {snapshot() === null ? <View accessibilityLabel="Waiting for host state"><PRIcon name="git-pull-request" size={16} /></View> : <PRIcon name={state().icon} size={16} tint={toneColor(state().tone, colorScheme())} />}
      <View role="link" accessibilityLabel={`Open #${link().number} ${title()}`} onPress={() => props.panel.onOpen(link())} onMouseMove={drag.onMouseMove} onPanStart={drag.onPanStart} onPanEnd={drag.onPanEnd} class="min-w-0 flex-1 flex-col">
        <View class="min-w-0 flex-row items-center gap-1.5">
          <Text class="shrink-0 text-xs font-medium text-muted-foreground tabular-nums" tooltip={<Tip label={`${LINK_SOURCE_LABELS[link().source] ?? link().source} · ${relativeTime(link().linkedAt, props.panel.now())}`} />}>{`#${link().number}`}</Text>
          <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{title()}</Text>
          {isOpenLink(link()) ? <>
            {link().watching ? <View accessibilityLabel="Watching" tooltip={<Tip label="Watching: the agent wakes when checks finish, someone comments, or the branch conflicts" />}><PRIcon name="eye" size={14} /></View> : null}
            {checks() ? <View accessibilityLabel={checks()!.label}><PRIcon name={checks()!.icon} size={14} tint={toneColor(checks()!.tone, colorScheme())} /></View> : null}
            {review() ? <View accessibilityLabel={review()!.label}><PRIcon name={review()!.icon} size={14} tint={toneColor(review()!.tone, colorScheme())} /></View> : null}
          </> : null}
          <Text class={`shrink-0 font-mono text-xs ${diffAdditionClass("text-success")}`}>{`+${snapshot()?.additions ?? 0}`}</Text>
          <Text class={`shrink-0 font-mono text-xs ${diffDeletionClass("text-destructive")}`}>{`-${snapshot()?.deletions ?? 0}`}</Text>
        </View>
        <View class="min-w-0 flex-row items-center gap-1.5">
          <MiddleTruncate value={snapshot() ? link().repository : `${link().host}/${link().repository}`} showTitle={false} textClass="font-mono text-2xs text-muted-foreground" />
          {snapshot() ? <Text class="min-w-0 truncate font-mono text-2xs text-muted-foreground">{`${snapshot()!.headBranch} -> ${snapshot()!.baseBranch}`}</Text> : null}
        </View>
      </View>
      <View ref={anchor.ref} role="button" accessibilityLabel={`Actions for #${link().number}`} onPress={() => menuOpen.update((open) => !open)} class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><Text class="text-sm text-muted-foreground">⋯</Text></View>
      {menuOpen() ? <Popup anchor={anchor.anchor} onClose={() => menuOpen.set(false)} placement="bottom" align="end" class="min-w-48">
        <View class="flex-col p-1">
          <MenuRow label="Copy link" icon="link" onPress={() => { menuOpen.set(false); void Clipboard.writeText(link().url).then(() => showToast({ type: "success", title: "Link copied" })).catch(() => undefined); }} />
          <MenuRow label="Open" icon="external-link" onPress={() => { menuOpen.set(false); props.panel.onOpen(link()); }} />
          {props.panel.supportsWatch && isOpenLink(link()) ? <MenuRow label={link().watching ? "Stop watching" : "Watch for changes"} icon="eye" onPress={() => void run(() => props.panel.dispatch(watchCommand(props.panel.threadId, link(), !link().watching)), "Could not change watching")} /> : null}
          <MenuRow label={unlinkMenuLabel(link())} icon="unlink" onPress={() => void run(() => props.panel.dispatch(unlinkCommand(props.panel.threadId, link())), "Could not unlink the pull request")} />
        </View>
      </Popup> : null}
    </View>
  );
}

export function ThreadPullRequestsPanel(props: ThreadPullRequestsPanelProps) {
  // The environment has not delivered its server config: the reference names that state (ThreadPullRequestsPanel).
  if (!(props.supported ?? pullRequestsSupported)()) {
    return <PullRequestsUnavailableState title="Linked pull requests unavailable" error="This environment does not support multiple linked pull requests." />;
  }
  const links = () => visibleThreadPullRequests(props.links());
  const syncedAt = () => null as string | null;
  return <View class="min-h-0 w-full min-w-0 flex-1 flex-col">{links().length === 0 ? (
    <View class="min-h-0 flex-1 items-center justify-center gap-2 p-6" accessibilityLabel="Linked pull requests">
      <PRIcon name="link" size={24} />
      <Text class="text-sm font-medium text-foreground">No linked pull requests</Text>
      <Text class="max-w-60 text-center text-xs text-muted-foreground">Pull requests the agent opens from this thread land here. Link one yourself from a URL or a number.</Text>
      <View role="button" accessibilityLabel="Link pull request" onPress={props.onLink} class="h-7 flex-row items-center gap-1.5 rounded-md border border-border px-2.5 hover:bg-accent-50"><PRIcon name="plus" size={14} /><Text class="text-sm text-foreground">Link pull request</Text></View>
    </View>
  ) : (
    <View class="min-h-0 w-full min-w-0 flex-1 flex-col" accessibilityLabel="Linked pull requests">
      <Scroll class="min-h-0 flex-1" contentClass="gap-0.5 p-1.5">
        <Each of={links()} key={(link) => `${link.host}/${link.repository}#${link.number}`}>{(link) => <LinkRow link={link()} panel={props} speed={() => false} />}</Each>
      </Scroll>
      <View class="flex-row items-center justify-between border-t border-border-60 px-2 py-1.5">
        <Text class="text-2xs text-muted-foreground">{threadPullRequestsSummary(links(), syncedAt(), props.now(), relativeTime)}</Text>
        <View role="button" accessibilityLabel="Link" onPress={props.onLink} class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50"><PRIcon name="plus" size={14} /><Text class="text-xs text-muted-foreground">Link</Text></View>
      </View>
    </View>
  )}</View>;
}
