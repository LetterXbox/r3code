// Complete Issue detail panel (IssueDetailPanel.tsx): header crumbs, editable title, state switcher,
// assignees & labels candidate pickers, markdown description with reactions, linked PRs, comments/events timeline,
// and floating comment composer.
import { effect, openUrl, Scroll, signal, Text, untracked, View } from "nsh";
import { Input, Menu, MenuItem } from "nsh/base";
import { settingValue } from "../../store";
import { createAnchor } from "../composer/Popover";
import { createHover } from "../hoverReveal";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS } from "../menuStyles";
import { PRIcon } from "../pullRequest/PRIcon";
import { PullRequestActorAvatar, PullRequestActorLabel } from "../pullRequest/PullRequestActorLabel";
import { PullRequestCandidatePicker } from "../pullRequest/PullRequestCandidatePicker";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { PullRequestDetailTitleRow, PullRequestMetaLine } from "../pullRequest/PullRequestDetailLayout";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { GhostBar } from "../pullRequest/PullRequestGhosts";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "../pullRequest/PullRequestReactions";
import { MetaRow, Section } from "../pullRequest/PullRequestSummaryTab";
import { relativeTime, toneColor, type Scheme } from "../pullRequest/pullRequestPresentation";
import { showToast } from "../toast";
import { IssueCommentComposer } from "./IssueCommentComposer";
import { IssueThreadLinks, type IssuePickerThread } from "./IssueThreadLinks";
import {
  issueEventSentence,
  issueStatePresentation,
  issueTrackerPresentation,
  issueWriteAccess,
  pullRequestLabelColor,
  type IssueAssigneeCandidate,
  type IssueCandidates,
  type IssueComment,
  type IssueDetail,
  type IssueEvent,
  type IssueLabelCandidate,
  type IssueLinkedPullRequest,
  type IssueReaction,
  type IssueRef,
} from "./issueLogic";
import {
  cachedIssueDetail,
  loadIssueCandidates,
  loadIssueDetail,
  loadOlderIssueComments,
  reactOnIssue,
  setIssueState,
  updateIssue,
  type RequestFn,
} from "./issueStore";

function scheme(): Scheme {
  return settingValue("colorScheme") === "light" ? "light" : "dark";
}

function mapReactions(reactions?: readonly IssueReaction[]) {
  return (reactions ?? []).map((r) => ({ content: r.content, count: r.count, viewerHasReacted: r.viewerReacted }));
}

function IssueLabelChip(props: { name: string; color: string | null }) {
  const color = props.color ? pullRequestLabelColor(props.color) : null;
  return (
    <View
      class={color ? "min-w-0 max-w-44 shrink flex-row items-center gap-1 rounded-full border px-2 py-0.5" : "min-w-0 max-w-44 shrink flex-row items-center gap-1 rounded-full bg-secondary px-2 py-0.5"}
      style={color ? { borderColor: `${color}66`, backgroundColor: `${color}1f` } : undefined}
    >
      <Text class="truncate text-2xs text-foreground">{props.name}</Text>
    </View>
  );
}

type TimelineItem =
  | { kind: "comment"; at: string; key: string; comment: IssueComment }
  | { kind: "event"; at: string; key: string; event: IssueEvent };

export function IssueDetailPanel(props: {
  environmentId: string;
  reference: IssueRef & { host: string };
  now: () => number;
  onClose?: () => void;
  closeInTabStrip?: boolean;
  onOpenHost?: (url: string) => void;
  onOpenPullRequest?: (pr: IssueLinkedPullRequest) => void;
  onStateChanged?: (nextState: IssueDetail["state"]) => void;
  currentThreadId?: () => string | null;
  currentThreadLinkedIds?: () => readonly { tracker: string; host: string; scope: string; key: string }[];
  threads?: {
    all: () => IssuePickerThread[];
    projectName: (projectId: string) => string;
    open: (threadId: string) => void;
  };
  request?: RequestFn;
}) {
  const editingTitle = signal(false);
  const titleDraft = signal("");
  const editingBody = signal(false);
  const saving = signal(false);
  const changingState = signal(false);
  const loadingOlder = signal(false);

  const labelPickerOpen = signal(false);
  const labelQuery = signal("");
  const assigneePickerOpen = signal(false);
  const assigneeQuery = signal("");
  const candidates = signal<{ loading: boolean; error: string | null; data: IssueCandidates | null }>({
    loading: false,
    error: null,
    data: null,
  });

  const pendingLabels = signal<string[] | null>(null);
  const pendingAssignees = signal<string[] | null>(null);
  const descHover = createHover();
  const stateAnchor = createAnchor();

  effect(() => {
    props.environmentId;
    props.reference.tracker;
    props.reference.host;
    props.reference.scope;
    props.reference.key;
    editingTitle.set(false);
    editingBody.set(false);
    pendingLabels.set(null);
    pendingAssignees.set(null);
    labelPickerOpen.set(false);
    assigneePickerOpen.set(false);
    untracked(() => { void loadIssueDetail(props.environmentId, props.reference, { request: props.request }); });
  });

  effect(() => {
    if (!labelPickerOpen() && !assigneePickerOpen()) return;
    untracked(() => {
      if (candidates().data || candidates().loading) return;
      candidates.set({ loading: true, error: null, data: null });
      void loadIssueCandidates([{ ...props.reference, environmentId: props.environmentId }], props.request)
        .then((data) => candidates.set({ loading: false, error: null, data }))
        .catch((cause) => candidates.set({ loading: false, error: cause instanceof Error ? cause.message : "Could not load options", data: null }));
    });
  });

  const slot = () => cachedIssueDetail(props.environmentId, props.reference);
  const detail = () => slot().detail;
  const openExternal = (url: string) => {
    if (props.onOpenHost) {
      props.onOpenHost(url);
    } else {
      void openUrl(url).catch(() => undefined);
    }
  };

  async function saveTitle() {
    const d = detail();
    const next = titleDraft().trim();
    if (!d || !next || next === d.title) {
      editingTitle.set(false);
      return;
    }
    saving.set(true);
    try {
      await updateIssue(props.environmentId, { ...props.reference, title: next }, props.request);
      editingTitle.set(false);
    } catch (cause) {
      showToast({
        type: "error",
        title: "The issue could not be updated",
        description: cause instanceof Error ? cause.message : "The tracker refused it.",
      });
    } finally {
      saving.set(false);
    }
  }

  async function saveBody(next: string) {
    saving.set(true);
    try {
      await updateIssue(props.environmentId, { ...props.reference, body: next }, props.request);
      editingBody.set(false);
    } catch (cause) {
      showToast({
        type: "error",
        title: "The issue could not be updated",
        description: cause instanceof Error ? cause.message : "The tracker refused it.",
      });
    } finally {
      saving.set(false);
    }
  }

  async function moveToState(stateName: string) {
    if (changingState()) return;
    changingState.set(true);
    try {
      const updated = await setIssueState(props.environmentId, { ...props.reference, state: stateName }, props.request);
      props.onStateChanged?.(updated.state);
    } catch (cause) {
      showToast({
        type: "error",
        title: "The state could not be changed",
        description: cause instanceof Error ? cause.message : "The tracker refused it.",
      });
    } finally {
      changingState.set(false);
    }
  }

  async function commitLabels() {
    const labels = pendingLabels();
    const d = detail();
    if (!labels || !d) return;
    const prev = d.labels.map((l) => l.name);
    if (JSON.stringify([...labels].sort()) === JSON.stringify([...prev].sort())) {
      pendingLabels.set(null);
      return;
    }
    try {
      await updateIssue(props.environmentId, { ...props.reference, labels }, props.request);
    } catch (cause) {
      showToast({
        type: "error",
        title: "Could not change labels",
        description: cause instanceof Error ? cause.message : "The tracker refused it.",
      });
    } finally {
      pendingLabels.set(null);
    }
  }

  async function commitAssignees() {
    const assignees = pendingAssignees();
    const d = detail();
    if (!assignees || !d) return;
    const prev = d.assignees.map((a) => a.login);
    if (JSON.stringify([...assignees].sort()) === JSON.stringify([...prev].sort())) {
      pendingAssignees.set(null);
      return;
    }
    try {
      await updateIssue(props.environmentId, { ...props.reference, assignees }, props.request);
    } catch (cause) {
      showToast({
        type: "error",
        title: "Could not change assignees",
        description: cause instanceof Error ? cause.message : "The tracker refused it.",
      });
    } finally {
      pendingAssignees.set(null);
    }
  }

  const timeline = (): TimelineItem[] => {
    const d = detail();
    if (!d) return [];
    const items: TimelineItem[] = [
      ...d.comments.map((comment): TimelineItem => ({ kind: "comment", at: comment.createdAt, key: `c:${comment.id}`, comment })),
      ...d.events.map((event): TimelineItem => ({ kind: "event", at: event.createdAt, key: `e:${event.id}`, event })),
    ];
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return items;
  };

  return (
    <View
      class={props.closeInTabStrip ? "min-w-0 flex-1 flex-col bg-background" : "min-w-0 flex-1 flex-col border-l border-border bg-background"}
      accessibilityLabel="Issue detail"
    >
      {slot().loading && !detail() ? (
        <View class="flex-1 flex-col gap-3 p-4">
          <GhostBar class="h-4 w-36" />
          <GhostBar class="h-6 w-3/4" />
          <GhostBar class="h-4 w-48" />
          <GhostBar class="mt-4 h-24 w-full" />
        </View>
      ) : null}

      {!slot().loading && slot().error && !detail() ? (
        <View class="flex-1 flex-col items-center justify-center gap-3 p-6">
          <Text class="text-sm font-medium text-foreground">Could not load issue</Text>
          <Text class="text-center text-xs text-muted-foreground">{slot().error!}</Text>
          <View
            role="button"
            accessibilityLabel="Retry loading issue"
            onPress={() => void loadIssueDetail(props.environmentId, props.reference, { force: true, request: props.request })}
            class="h-7 flex-row items-center gap-1.5 rounded-md border border-border px-3 hover:bg-accent-50"
          >
            <PRIcon name="refresh-cw" size={12} />
            <Text class="text-xs text-foreground">Retry</Text>
          </View>
        </View>
      ) : null}

      {detail() ? (() => {
        const d = detail()!;
        const write = issueWriteAccess(d, true);
        const stateUi = issueStatePresentation(d.state);
        const trackerUi = issueTrackerPresentation(d.tracker);
        const otherStates = d.states.filter((s) => s.name !== d.state.name);
        const currentLabels = () => pendingLabels() ?? d.labels.map((l) => l.name);
        const currentAssignees = () => pendingAssignees() ?? d.assignees.map((a) => a.login);

        return (
          <View class="min-h-0 flex-1 flex-col">
            <View class="shrink-0 flex-col border-b border-border-60">
              <View class="h-8 flex-row items-center justify-between gap-2 px-4">
                <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                  <PRIcon name={trackerUi.icon} size={13} />
                  <Text class="truncate text-xs font-medium text-muted-foreground">{d.scope}</Text>
                  <View
                    role="link"
                    accessibilityLabel={`Open ${d.displayKey} in ${trackerUi.providerName}`}
                    tooltip={`Open in ${trackerUi.providerName}`}
                    onPress={() => openExternal(d.url)}
                    class="shrink-0 flex-row items-center gap-0.5 hover:opacity-80"
                  >
                    <Text class="font-mono text-xs font-medium" style={{ color: toneColor(stateUi.tone, scheme()) }}>{d.displayKey}</Text>
                    <PRIcon name="external-link" size={10} />
                  </View>
                </View>
                <View class="shrink-0 flex-row items-center gap-1">
                  <IssueThreadLinks
                    environmentId={props.environmentId}
                    reference={props.reference}
                    issue={d}
                    currentThreadId={props.currentThreadId}
                    currentThreadLinkedIds={props.currentThreadLinkedIds}
                    threads={props.threads}
                    request={props.request}
                  />
                  {!props.closeInTabStrip && props.onClose ? (
                    <View
                      role="button"
                      accessibilityLabel="Close issue detail"
                      onPress={props.onClose}
                      class="size-6 items-center justify-center rounded-md hover:bg-accent-50"
                    >
                      <PRIcon name="x" size={14} />
                    </View>
                  ) : null}
                </View>
              </View>

              <View class="flex-col gap-2 px-4 pb-3 pt-1">
                {editingTitle() ? (
                  <View class="flex-row items-center gap-2">
                    <Input
                      autoFocus
                      accessibilityLabel="Edit issue title"
                      disabled={saving()}
                      value={titleDraft()}
                      onChange={(event) => titleDraft.set(event.value)}
                      onSubmitEditing={() => void saveTitle()}
                      onKeyDown={(event) => { if (event.key === "Escape") editingTitle.set(false); }}
                      class="min-w-0 flex-1 rounded-md border border-input bg-card px-2 py-1 text-base font-semibold text-foreground"
                    />
                    <View role="button" accessibilityLabel="Save title" onPress={() => void saveTitle()} class="h-7 flex-row items-center rounded-md border border-border px-2 hover:bg-accent-50">
                      <Text class="text-xs text-foreground">{saving() ? "Saving..." : "Save"}</Text>
                    </View>
                    <View role="button" accessibilityLabel="Cancel editing title" onPress={() => editingTitle.set(false)} class="h-7 flex-row items-center rounded-md px-2 hover:bg-accent-50">
                      <Text class="text-xs text-muted-foreground">Cancel</Text>
                    </View>
                  </View>
                ) : (
                  <PullRequestDetailTitleRow>
                    <Text class="min-w-0 flex-1 text-base font-semibold text-foreground">{d.title}</Text>
                    {write.edit ? (
                      <View
                        role="button"
                        accessibilityLabel="Edit issue title"
                        onPress={() => { titleDraft.set(d.title); editingTitle.set(true); }}
                        class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent-50"
                      >
                        <PRIcon name="pencil" size={12} />
                      </View>
                    ) : null}
                  </PullRequestDetailTitleRow>
                )}

                <View class="flex-row items-center justify-between gap-2">
                  <PullRequestMetaLine>
                    {[
                      <PullRequestActorLabel actor={d.author ? { login: d.author.login, avatarUrl: d.author.avatarUrl ?? undefined } : null} />,
                      <Text class="text-xs text-muted-foreground">{`updated ${relativeTime(d.updatedAt, props.now())}`}</Text>,
                    ]}
                  </PullRequestMetaLine>
                  {otherStates.length > 0 && write.states.length > 0 ? (
                    <Menu
                      align="end"
                      popupClass={MENU_POPUP_CLASS}
                      trigger={
                        <View
                          ref={stateAnchor.ref}
                          role="button"
                          accessibilityLabel={`Issue state, ${stateUi.label}`}
                          accessibilityState={{ disabled: changingState() }}
                          class="h-6 flex-row items-center gap-1 rounded-md border border-border px-2 hover:bg-accent-50"
                        >
                          <PRIcon name={stateUi.icon} size={13} tint={toneColor(stateUi.tone, scheme())} />
                          <Text class="text-xs font-medium text-foreground">{stateUi.label}</Text>
                          <PRIcon name="chevron-down" size={12} />
                        </View>
                      }
                    >
                      {otherStates.map((nextState) => {
                        const pres = issueStatePresentation(nextState);
                        return (
                          <MenuItem accessibilityLabel={nextState.name} onSelect={() => void moveToState(nextState.name)} class={MENU_ITEM_ROW_CLASS}>
                            <PRIcon name={pres.icon} size={MENU_ITEM_ICON_SIZE} tint={toneColor(pres.tone, scheme())} />
                            <Text class="text-sm text-foreground">{nextState.name}</Text>
                          </MenuItem>
                        );
                      })}
                    </Menu>
                  ) : (
                    <View class="flex-row items-center gap-1">
                      <PRIcon name={stateUi.icon} size={13} tint={toneColor(stateUi.tone, scheme())} />
                      <Text class="text-xs font-medium text-foreground">{stateUi.label}</Text>
                    </View>
                  )}
                </View>
              </View>
            </View>

            <Scroll class="min-h-0 flex-1">
              <View class="flex-col">
                <View class="flex-col gap-2 border-b border-border-60 px-4 py-3">
                  <MetaRow icon="users" label="Assignees">
                    <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5">
                      {d.assignees.length === 0 ? <Text class="text-xs text-muted-foreground">Unassigned</Text> : null}
                      {d.assignees.map((assignee) => (
                        <PullRequestActorLabel actor={{ login: assignee.login, avatarUrl: assignee.avatarUrl ?? undefined }} />
                      ))}
                    </View>
                    <PullRequestCandidatePicker<IssueAssigneeCandidate>
                      icon="user-plus"
                      label="Change assignees"
                      allowed={write.assignees}
                      disabledReason={write.blocked ?? "Assignees cannot be changed here."}
                      open={assigneePickerOpen}
                      onToggle={() => {
                        const next = !assigneePickerOpen();
                        assigneePickerOpen.set(next);
                        if (next) {
                          pendingAssignees.set(d.assignees.map((a) => a.login));
                        } else {
                          void commitAssignees();
                        }
                      }}
                      query={assigneeQuery}
                      onQueryChange={(v) => assigneeQuery.set(v)}
                      searchLabel="Search people"
                      isPending={() => candidates().loading}
                      error={() => candidates().error}
                      candidates={() => {
                        const needle = assigneeQuery().trim().toLowerCase();
                        return (candidates().data?.assignees ?? []).filter(
                          (a) => !needle || a.login.toLowerCase().includes(needle) || (a.name ?? "").toLowerCase().includes(needle),
                        );
                      }}
                      emptyLabel="Nobody can be assigned here."
                      noMatchLabel="Nobody matches that."
                      errorLabel="The people could not be read."
                      truncatedLabel={() => (candidates().data?.truncated ? "More people exist than are listed here." : null)}
                      candidateKey={(candidate) => candidate.id}
                      disabled={() => saving()}
                      onSelect={(candidate) => {
                        const cur = new Set(currentAssignees());
                        if (cur.has(candidate.login)) cur.delete(candidate.login);
                        else cur.add(candidate.login);
                        pendingAssignees.set([...cur]);
                      }}
                      row={(candidate) => (
                        <View class="min-w-0 flex-1 flex-row items-center justify-between gap-2">
                          <PullRequestActorLabel actor={{ login: candidate.login, avatarUrl: candidate.avatarUrl ?? undefined }} />
                          {currentAssignees().includes(candidate.login) ? <PRIcon name="check" size={14} /> : null}
                        </View>
                      )}
                    />
                  </MetaRow>

                  {d.capabilities.labels || d.labels.length > 0 ? (
                    <MetaRow icon="tag" label="Labels">
                      <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-1">
                        {d.labels.length === 0 ? <Text class="text-xs text-muted-foreground">None</Text> : null}
                        {d.labels.map((label) => <IssueLabelChip name={label.name} color={label.color} />)}
                      </View>
                      <PullRequestCandidatePicker<IssueLabelCandidate>
                        icon="tag"
                        label="Change labels"
                        allowed={write.labels}
                        disabledReason={write.blocked ?? "Labels cannot be changed here."}
                        open={labelPickerOpen}
                        onToggle={() => {
                          const next = !labelPickerOpen();
                          labelPickerOpen.set(next);
                          if (next) {
                            pendingLabels.set(d.labels.map((l) => l.name));
                          } else {
                            void commitLabels();
                          }
                        }}
                        query={labelQuery}
                        onQueryChange={(v) => labelQuery.set(v)}
                        searchLabel="Search labels"
                        isPending={() => candidates().loading}
                        error={() => candidates().error}
                        candidates={() => {
                          const needle = labelQuery().trim().toLowerCase();
                          return (candidates().data?.labels ?? []).filter((l) => !needle || l.name.toLowerCase().includes(needle));
                        }}
                        emptyLabel="No labels in this project."
                        noMatchLabel="No label matches that."
                        errorLabel="The labels could not be read."
                        truncatedLabel={() => (candidates().data?.truncated ? "More labels exist than are listed here." : null)}
                        candidateKey={(candidate) => candidate.name}
                        disabled={() => saving()}
                        onSelect={(candidate) => {
                          const cur = new Set(currentLabels());
                          if (cur.has(candidate.name)) cur.delete(candidate.name);
                          else cur.add(candidate.name);
                          pendingLabels.set([...cur]);
                        }}
                        row={(candidate) => (
                          <View class="min-w-0 flex-1 flex-row items-center justify-between gap-2">
                            <View class="min-w-0 flex-1 flex-row items-center gap-2">
                              {candidate.color ? <View class="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: pullRequestLabelColor(candidate.color) ?? undefined }} /> : null}
                              <Text class="truncate text-sm text-foreground">{candidate.name}</Text>
                            </View>
                            {currentLabels().includes(candidate.name) ? <PRIcon name="check" size={14} /> : null}
                          </View>
                        )}
                      />
                    </MetaRow>
                  ) : null}
                </View>

                <Section
                  title="Description"
                  actions={
                    write.edit && !editingBody() ? (
                      <PullRequestEditButton label="Edit description" hovered={descHover.hovered} onPress={() => editingBody.set(true)} />
                    ) : undefined
                  }
                >
                  <View {...descHover.handlers} class="flex-col gap-2">
                    {editingBody() ? (
                      <PullRequestMarkdownEditor
                        value={d.body}
                        label="Edit issue description"
                        saving={saving}
                        allowEmpty
                        onSave={(next) => void saveBody(next)}
                        onCancel={() => editingBody.set(false)}
                      />
                    ) : d.body.trim().length > 0 ? (
                      <PullRequestCommentBody class="min-w-0" text={() => d.body} provider={d.tracker} />
                    ) : (
                      <Text class="text-xs text-muted-foreground">No description provided.</Text>
                    )}
                    {write.react || (d.reactions?.length ?? 0) > 0 ? (
                      <PullRequestReactionBar
                        reactions={() => mapReactions(d.reactions)}
                        canReact={() => write.react}
                        onToggle={(content, reacted) => reactOnIssue(props.environmentId, { ...props.reference, content, reacted }, props.request)}
                        onFailed={(message) => showToast({ type: "error", title: message })}
                      />
                    ) : null}
                  </View>
                </Section>

                {d.linkedPullRequests.length > 0 ? (
                  <Section title={`Pull requests (${d.linkedPullRequests.length})`}>
                    <View class="flex-col gap-1">
                      {d.linkedPullRequests.map((pr) => (
                        <View
                          role="button"
                          accessibilityLabel={`Open pull request #${pr.number}: ${pr.title}`}
                          onPress={() => {
                            if (props.onOpenPullRequest) props.onOpenPullRequest(pr);
                            else openExternal(pr.url);
                          }}
                          class="flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent-50"
                        >
                          <PRIcon name={pr.state.toLowerCase() === "merged" ? "git-merge" : pr.state.toLowerCase() === "closed" ? "git-pull-request-closed" : "git-pull-request"} size={14} />
                          <Text class="shrink-0 font-mono text-xs text-muted-foreground">{`#${pr.number}`}</Text>
                          <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{pr.title}</Text>
                          {pr.closesIssue ? <Text class="shrink-0 text-2xs text-muted-foreground">closes</Text> : null}
                        </View>
                      ))}
                    </View>
                  </Section>
                ) : null}

                <Section title={`Activity (${d.commentCount || timeline().length})`}>
                  <View class="flex-col gap-3">
                    {d.commentsCursor ? (
                      <View
                        role="button"
                        accessibilityLabel="Load older comments"
                        accessibilityState={{ disabled: loadingOlder() }}
                        onPress={() => {
                          if (loadingOlder()) return;
                          loadingOlder.set(true);
                          void loadOlderIssueComments(props.environmentId, props.reference, props.request)
                            .catch(() => showToast({ type: "error", title: "Older comments could not be read" }))
                            .finally(() => loadingOlder.set(false));
                        }}
                        class="h-7 self-start flex-row items-center rounded-md border border-border px-2.5 hover:bg-accent-50"
                      >
                        <Text class="text-xs text-foreground">{loadingOlder() ? "Loading..." : "Load older comments"}</Text>
                      </View>
                    ) : null}

                    {timeline().length === 0 ? (
                      <Text class="text-xs text-muted-foreground">No activity yet.</Text>
                    ) : null}

                    {timeline().map((item) => {
                      if (item.kind === "event") {
                        const actorName = item.event.actor?.login ?? "someone";
                        return (
                          <View class="flex-row items-center gap-2 px-1 py-0.5">
                            <PRIcon name="git-commit-horizontal" size={12} />
                            <Text class="min-w-0 flex-1 text-xs text-muted-foreground">
                              {`${actorName} ${issueEventSentence(item.event)}`}
                            </Text>
                            <Text class="shrink-0 text-2xs text-muted-foreground">{relativeTime(item.at, props.now())}</Text>
                          </View>
                        );
                      }
                      const c = item.comment;
                      return (
                        <View class="flex-col gap-1.5 rounded-lg border border-border-60 bg-card p-3">
                          <View class="flex-row items-center justify-between gap-2">
                            <PullRequestActorLabel actor={c.author ? { login: c.author.login, avatarUrl: c.author.avatarUrl ?? undefined } : null} />
                            <Text class="shrink-0 text-2xs text-muted-foreground">{relativeTime(c.createdAt, props.now())}</Text>
                          </View>
                          <PullRequestCommentBody class="min-w-0" text={() => c.body} provider={d.tracker} />
                          {write.react || (c.reactions?.length ?? 0) > 0 ? (
                            <PullRequestReactionBar
                              reactions={() => mapReactions(c.reactions)}
                              canReact={() => write.react}
                              onToggle={(content, reacted) => reactOnIssue(props.environmentId, { ...props.reference, subjectId: c.id, content, reacted }, props.request)}
                              onFailed={(message) => showToast({ type: "error", title: message })}
                            />
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                </Section>
              </View>
            </Scroll>

            {d.capabilities.comment ? (
              <IssueCommentComposer
                environmentId={props.environmentId}
                reference={props.reference}
                blocked={write.comment ? null : (write.blocked ?? "You cannot comment on this issue.")}
                request={props.request}
              />
            ) : null}
          </View>
        );
      })() : null}
    </View>
  );
}
