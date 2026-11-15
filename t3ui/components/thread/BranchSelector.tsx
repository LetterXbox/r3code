// The integrated, searchable branch combobox of the branch toolbar (BranchToolbarBranchSelector.tsx
// and BranchPicker.tsx): one trigger, a popup with "Search refs..." on top, the ref list with
// current / worktree / remote / default badges, "Create new ref" for a name that does not exist
// yet, and a status line. A pick shows its result at once and rolls back if the switch fails.
import { vcsRefsRevision } from "../../backend/rpcConcurrency";
import { MiddleTruncate } from "../MiddleTruncate";
import { effect, keymap, signal, Scroll, Text, untracked, View } from "nsh";
import { Input, Switch } from "nsh/base";
import { ComposerIcon } from "../composer/ComposerIcon";
import { createAnchor, Popup } from "../composer/Popover";
import { moveHighlight } from "../composer/modelPickerLogic";
import { CHECKOUT_PR_PREFIX, CREATE_PREFIX, localNameFromRemoteRef, parsePickerRefs, pickerItems, refBadge, sanitizeNewRefName, selectionTarget, statusText, triggerLabel } from "./branchLogic";
import type { PickerRef } from "./branchLogic";
import { ContextLabel } from "./ContextLabel";
import { HIcon } from "../header/HeaderIcons";

const PAGE = 100;

export interface BranchChange { branch: string; worktreePath: string | null }

export function BranchSelector(props: {
  /** Where refs are read and a checkout runs: the thread's worktree, else the project. */
  cwd: () => string | null;
  projectCwd: () => string | null;
  activeWorktreePath: () => string | null;
  /** The branch the thread is on, as the toolbar last knew it. */
  branch: () => string | null;
  /** A new worktree picks its base ref instead of switching a checkout. */
  selectingWorktreeBase: () => boolean;
  canCreate: () => boolean;
  disabled: () => boolean;
  request: (method: string, payload: unknown) => Promise<unknown>;
  onSelectBase: (refName: string) => void;
  onBranchChanged: (change: BranchChange) => void;
  /** Lets a command (composer.branch) open the picker. */
  open?: { (): boolean; set(value: boolean): void };
  /** "Start from remote": offered while a new worktree picks its base ref. */
  startFromOrigin?: () => boolean;
  onStartFromOriginChange?: (checked: boolean) => void;
  /** A query that is a pull request reference offers "Checkout Pull request"; the host prepares the checkout. */
  onCheckoutPullRequest?: (reference: string) => void;
  /**
   * `displayMode="panel"` (BranchToolbarBranchSelector in the thread details card): the trigger is a full-width row with
   * the branch mark and a chevron, and the popup opens under it. The composer strip's compact trigger is the default.
   */
  variant?: "composer" | "panel";
  /** Whether the connection may change the thread's branch (`runBranchAction`); a switch or create it refuses calls `onUnavailable`. */
  canChange?: () => boolean;
  onUnavailable?: () => void;
  /** A failed switch or create is reported here (a toast in the card) instead of under the trigger. */
  onError?: (message: string, action: "switch" | "create") => void;
  /** The trigger's context menu (Copy branch name in the card). */
  onTriggerContextMenu?: (event: { pagePosition: { x: number; y: number } }, branch: string | null) => void;
}) {
  const open = props.open ?? signal(false);
  const anchor = createAnchor();
  const query = signal("");
  const highlight = signal(0);
  const refs = signal<PickerRef[]>([]);
  const currentRef = signal<string | null>(null);
  const total = signal(0);
  const nextCursor = signal<number | null>(null);
  const loading = signal(false);
  const loadingMore = signal(false);
  const pending = signal(false);
  const optimistic = signal<string | null>(null);
  const error = signal("");
  let serial = 0;

  async function load(search: string, cursor?: number) {
    const cwd = props.cwd();
    if (!cwd) return;
    const mine = ++serial;
    if (cursor === undefined) loading.set(true); else loadingMore.set(true);
    try {
      const sanitized = sanitizeNewRefName(search);
      const result = parsePickerRefs(await props.request("vcs.listRefs", {
        cwd, limit: PAGE, refKind: "all", ...(sanitized ? { query: sanitized.slice(0, 256) } : {}), ...(cursor !== undefined ? { cursor } : {}),
      }));
      if (mine !== serial) return;
      refs.set(cursor === undefined ? result.refs : [...refs(), ...result.refs]);
      total.set(result.totalCount);
      nextCursor.set(result.nextCursor);
      if (!sanitized && cursor === undefined) currentRef.set(result.refs.find((ref) => ref.current && !ref.isRemote)?.name ?? null);
    } catch (cause) {
      if (mine === serial) error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mine === serial) { loading.set(false); loadingMore.set(false); }
    }
  }

  // The label needs the current ref, so refs load before the popup opens and again on every search.
  effect(() => {
    // state/vcs.ts invalidateRefs: a settled createRef / switchRef / preparePullRequestThread reloads the list.
    vcsRefsRevision(props.cwd());
    const search = open() ? query() : "";
    untracked(() => { void load(search); });
  });

  // BranchToolbarBranchSelector handleOpenChange: opening the menu asks for a local-only status refresh of branchCwd.
  let wasOpen = false;
  effect(() => {
    const isOpen = open();
    untracked(() => {
      const branchCwd = props.activeWorktreePath() ?? props.projectCwd();
      if (isOpen && !wasOpen && branchCwd) void props.request("vcs.refreshStatus", { cwd: branchCwd, localOnly: true }).catch(() => {});
      wasOpen = isOpen;
    });
  });

  const picker = () => pickerItems({
    refs: refs(), query: query(), canCreate: props.canCreate() && !props.selectingWorktreeBase(),
    canCheckoutPullRequest: props.onCheckoutPullRequest !== undefined && props.canCreate() && !props.selectingWorktreeBase(),
  });
  const items = () => picker().items;
  effect(() => { const length = items().length; if (highlight() >= length) highlight.set(Math.max(0, length - 1)); });
  effect(() => {
    if (!open()) return;
    return keymap.bind({
      up: () => highlight.set(moveHighlight(highlight(), -1, items().length)),
      down: () => highlight.set(moveHighlight(highlight(), 1, items().length)),
    }, { when: "always", repeat: true });
  });

  const resolvedBranch = () => optimistic() ?? (props.selectingWorktreeBase() ? props.branch() : (currentRef() ?? props.branch()));
  const label = () => {
    const branch = resolvedBranch();
    const known = branch ? refs().find((ref) => ref.name === branch) : undefined;
    return triggerLabel({ selectingWorktreeBase: props.selectingWorktreeBase(), branch, startFromOrigin: props.startFromOrigin?.() ?? false, branchIsRemote: known ? known.isRemote : null });
  };

  function close() { open.set(false); query.set(""); highlight.set(0); }

  async function switchTo(ref: PickerRef) {
    const projectCwd = props.projectCwd();
    if (!projectCwd || pending()) return;
    if (props.selectingWorktreeBase()) { props.onSelectBase(ref.name); close(); return; }
    if (props.canChange && !props.canChange()) { close(); props.onUnavailable?.(); return; }
    const target = selectionTarget({ projectCwd, activeWorktreePath: props.activeWorktreePath(), ref });
    const selectedName = ref.isRemote ? localNameFromRemoteRef(ref.name) : ref.name;
    close();
    if (target.reuseExistingWorktree) { props.onBranchChanged({ branch: ref.name, worktreePath: target.nextWorktreePath }); return; }
    await run(selectedName, "switch", async () => {
      const result = (await props.request("vcs.switchRef", { cwd: target.checkoutCwd, refName: ref.name })) as { refName?: string | null } | null;
      props.onBranchChanged({ branch: ref.isRemote ? (result?.refName ?? selectedName) : selectedName, worktreePath: target.nextWorktreePath });
    });
  }

  async function create(raw: string) {
    const name = sanitizeNewRefName(raw);
    const cwd = props.cwd();
    if (!cwd || !name || pending() || !props.canCreate()) return;
    if (props.canChange && !props.canChange()) { close(); props.onUnavailable?.(); return; }
    close();
    await run(name, "create", async () => {
      const result = (await props.request("vcs.createRef", { cwd, refName: name, switchRef: true })) as { refName?: string } | null;
      props.onBranchChanged({ branch: result?.refName ?? name, worktreePath: props.activeWorktreePath() });
    });
  }

  /** Shows the target branch at once, and puts the previous one back if the server refuses. */
  async function run(target: string, kind: "switch" | "create", action: () => Promise<void>) {
    pending.set(true);
    error.set("");
    optimistic.set(target);
    try {
      await action();
      currentRef.set(target);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (props.onError) props.onError(message, kind); else error.set(message);
    } finally {
      optimistic.set(null);
      pending.set(false);
      void load("");
    }
  }

  function pick(value: string) {
    if (value.startsWith(CHECKOUT_PR_PREFIX)) { const reference = value.slice(CHECKOUT_PR_PREFIX.length); close(); props.onCheckoutPullRequest?.(reference); return; }
    if (value.startsWith(CREATE_PREFIX)) { void create(value.slice(CREATE_PREFIX.length)); return; }
    const ref = refs().find((entry) => entry.name === value);
    if (ref) void switchTo(ref);
  }

  const busy = () => props.disabled() || pending() || (loading() && refs().length === 0 && !open());
  return (
    <View class={props.variant === "panel" ? "w-full" : "min-w-0 shrink"}>
      {props.variant === "panel" ? (
        <View
          ref={anchor.ref}
          class={`h-8 w-full flex-row items-center gap-2.5 rounded-lg px-2.5 ${open() ? "bg-details-row-hover" : "hover:bg-details-row-hover"} ${pending() ? "opacity-64" : ""}`}
          disabled={busy()}
          onPress={() => { if (!busy()) open.set(!open()); }}
          onContextMenu={(event) => props.onTriggerContextMenu?.(event, resolvedBranch())}
          accessibilityLabel={`Branch ${label()}`}
          role="button"
        >
          <HIcon name="git-branch" size={16} />
          <MiddleTruncate value={label()} class="flex-1" textClass="text-[13px] font-medium text-details-label" />
          <HIcon name="chevron-down" size={16} />
        </View>
      ) : (
      <View
        ref={anchor.ref}
        class={`h-6 min-w-0 flex-row items-center gap-1 rounded-md border border-transparent px-1.5 ${open() ? "bg-accent" : "hover:bg-accent"} ${pending() ? "opacity-64" : ""}`}
        disabled={busy()}
        onPress={() => { if (!busy()) open.set(!open()); }}
        accessibilityLabel="Select branch"
        role="button"
      >
        <ComposerIcon name="git-branch" size={12} />
        <ContextLabel text={label} />
      </View>
      )}
      {error() ? <Text class="px-1.5 pt-1 text-xs text-error-foreground">{error()}</Text> : null}
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={close} placement={props.variant === "panel" ? "bottom" : "top"} align={props.variant === "panel" ? "start" : "end"} class={props.variant === "panel" ? "w-[264px]" : "w-80"}>
          <View accessibilityLabel="Branches" role="listbox">
            <View class="h-9 flex-row items-center gap-2 border-b border-border-70 px-3">
              <ComposerIcon name="search" size={14} />
              <Input
                autoFocus
                value={query()}
                onChange={(event) => { query.set(event.value); highlight.set(0); }}
                onSubmit={() => { const value = items()[highlight()]; if (value) pick(value); }}
                placeholder="Search refs..."
                accessibilityLabel="Search refs"
                class="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground"
              />
            </View>
            {items().length === 0 && !loading() ? (
              <View class="px-4 py-3"><Text class="text-sm text-muted-foreground">No refs found.</Text></View>
            ) : (
              <Scroll class="max-h-56">
                <View class="gap-0.5 py-2 ps-1 pe-1">
                  <Each of={items()} key={(value) => value}>
                    {(value, index) => {
                      const ref = () => refs().find((entry) => entry.name === value());
                      const badge = () => { const entry = ref(); return entry ? refBadge(entry, props.projectCwd()) : null; };
                      return (
                        <View
                          class={`min-h-7 flex-row items-center justify-between gap-2 rounded-md px-2 ${highlight() === index() ? "bg-accent" : ""}`}
                          onPress={() => pick(value())}
                          onMouseEnter={() => highlight.set(index())}
                          accessibilityLabel={value().startsWith(CHECKOUT_PR_PREFIX) ? "Checkout Pull request" : value().startsWith(CREATE_PREFIX) ? `Create new ref "${sanitizeNewRefName(value().slice(CREATE_PREFIX.length))}"` : value()}
                          role="option"
                        >
                          {value().startsWith(CHECKOUT_PR_PREFIX) ? (
                            <View class="min-w-0 flex-1 flex-row items-center gap-2 py-1">
                              <ComposerIcon name="git-pull-request" size={14} />
                              <View class="min-w-0 flex-1">
                                <Text class="truncate text-sm font-medium text-foreground">Checkout Pull request</Text>
                                <Text class="truncate text-xs text-muted-foreground">{value().slice(CHECKOUT_PR_PREFIX.length)}</Text>
                              </View>
                            </View>
                          ) : value().startsWith(CREATE_PREFIX) ? (
                            <View class="min-w-0 flex-1 flex-row items-center gap-2">
                              <Text class="truncate text-sm text-foreground">{`Create new ref "${sanitizeNewRefName(value().slice(CREATE_PREFIX.length))}"`}</Text>
                            </View>
                          ) : (
                            <>
                              <MiddleTruncate value={value()} class="flex-1" textClass="text-sm text-foreground" />
                              {badge() ? <Text class="shrink-0 text-3xs text-muted-foreground">{badge()}</Text> : null}
                            </>
                          )}
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </Scroll>
            )}
            {props.selectingWorktreeBase() && props.onStartFromOriginChange ? (
              <View class="flex-row items-center justify-between gap-3 border-t border-border-60 px-3 py-2" accessibilityLabel="Start from remote">
                <View class="min-w-0 flex-row items-center gap-1.5">
                  <ComposerIcon name="refresh-cw" size={12} />
                  <Text class="truncate text-xs font-medium text-muted-foreground">Start from remote</Text>
                </View>
                <Switch
                  checked={props.startFromOrigin?.() ?? false}
                  onChange={(e: { checked?: boolean; value?: boolean }) => props.onStartFromOriginChange?.(Boolean(e?.checked ?? e?.value))}
                  accessibilityLabel="Start worktree from remote"
                  testID={`Start worktree from remote (${props.startFromOrigin?.() ? "on" : "off"})`}
                  class="h-4 w-7 items-center"
                  trackClass="h-4 w-6.5 justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out"
                  thumbClass="size-3 rounded-full bg-background checked:translate-x-2.5 transition-transform duration-150 ease-in-out"
                />
              </View>
            ) : null}
            {statusText({ loading: loading() && refs().length === 0, loadingMore: loadingMore(), shown: refs().length, total: total(), hasMore: nextCursor() !== null }) ? (
              <View class="flex-row items-center justify-between gap-2 border-t border-border-70 px-3 py-2">
                <Text class="text-xs text-muted-foreground">{statusText({ loading: loading() && refs().length === 0, loadingMore: loadingMore(), shown: refs().length, total: total(), hasMore: nextCursor() !== null })}</Text>
                {nextCursor() !== null && !loadingMore() ? (
                  <View onPress={() => { const cursor = nextCursor(); if (cursor !== null) void load(query(), cursor); }} accessibilityLabel="Load more refs" role="button" class="rounded-md px-1.5 py-0.5 hover:bg-accent">
                    <Text class="text-xs text-foreground">Load more</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </Popup>
      ) : null}
    </View>
  );
}
