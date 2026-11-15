// The composer's context strip under the card (BranchToolbar.tsx, composer layout): the workspace
// control on the left and the branch combobox on the right. The project is chosen in the draft hero's
// heading, as in the web, so the strip has no project control. A new thread picks Current checkout /
// New worktree / Previous worktree, the base ref of a new worktree, and "Start from remote"; a started
// thread shows its workspace locked and switches its branch.
import { changeDraftEnvironment, draftEnvironmentKey, logicalProjectEnvironments } from "../../environments/logicalProjectEnvironments";
import { effect, LayoutAnimation, reduceMotion, signal, untracked, View, Text } from "nsh";
import { subscribeBackend } from "../../store";
import { allProjects, allThreads, availableRuntimeModes, backendStatus, backendUrl, configureBackend, isSending, isServerThread, openThread, requestBackend, runtimeMode, setRuntimeMode, settingValue } from "../../store";
import { StripPermissions } from "./ModeControls";
import { showToast } from "../toast/toastState";
import { canOperateThread, canWriteSourceControl } from "../header/sourceControlScope";
import type { WorkspaceStrategy } from "../../store";
import { branchPickerOpen, previousWorktreeRequests, workspaceMenuRequests } from "../composer/composerControls";
import { BranchSelector } from "./BranchSelector";
import { branchActionFailureTitle } from "./branchLogic";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { watchVcsStatus } from "../header/gitRuntime";
import type { BranchChange } from "./BranchSelector";
import { shouldShowComposerContextStrip } from "./contextStrip";
import { EnvModeSelector } from "./EnvModeSelector";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { autoEnvironmentLabel, canAutoBalance, chooseAutoEnvironment, chooseManualEnvironment } from "../../environments/loadBalancing";
import { addProjectTargets, openAddProjectToMachine } from "../../environments/AddProjectToMachineDialog";
import { buildEnvironmentOptions, shouldShowEnvironmentIndicator } from "./environmentOptions";
import { hostMenuRequests } from "../composer/composerControls";
import { shortcutLabel } from "../../commands/registry";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { loadSavedEnvironments, savedEnvironments } from "../../pages/settings/environments/savedEnvironments";
import { parseWorkspaceRefs, resolvePreviousWorktreeSeed } from "./workspaceRefs";
import { reportContextStripSpacer, watchContextStrip } from "./contextStripCompact";
import { CONTEXT_LABEL_MS } from "./ContextLabel";

export type WorkspaceChoice = WorkspaceStrategy;

/** The branch a strategy is on, where it names one. */
function strategyBranch(strategy: WorkspaceChoice): string | null {
  if (strategy.type === "worktree") return strategy.baseRef;
  return strategy.branch ?? null;
}

export function WorkspaceControls(props: {
  strategy: () => WorkspaceChoice;
  /** Kept for callers that still pass it: the draft hero owns the project picker. */
  onSelectProject?: (projectId: string) => void;
  onSelectWorkspace: (strategy: WorkspaceChoice) => void;
  /** Transport for tests; the app uses the connected environment. */
  request?: (method: string, payload: unknown) => Promise<unknown>;
}) {
  const error = signal("");
  const branches = signal<Record<string, string>>({});
  const request = (method: string, payload: unknown) => (props.request ?? requestBackend)(method, payload);
  const project = () => allProjects().find((item) => item.id === openThread()?.projectId);
  const connected = () => backendStatus() === "connected";
  const locked = () => isServerThread(openThread()?.id ?? "");
  const editable = () => {
    const thread = openThread();
    return Boolean(thread && !isServerThread(thread.id) && connected() && !isSending());
  };
  const strategy = () => props.strategy();
  const activeWorktree = () => {
    const current = strategy();
    if (locked()) return openThread()?.path ?? null;
    return current.type === "existing_worktree" ? current.worktreePath : null;
  };

  // Which branch each of the project's worktrees holds, for the Previous worktree row.
  let refsSerial = 0;
  effect(() => {
    const cwd = project()?.path;
    const draft = !locked();
    if (!cwd || !draft || !connected()) { branches.set({}); return; }
    const serial = ++refsSerial;
    untracked(() => {
      void request("vcs.listRefs", { cwd, limit: 100, refKind: "all" })
        .then((value) => {
          if (serial !== refsSerial) return;
          const map: Record<string, string> = {};
          for (const ref of parseWorkspaceRefs(value).refs) if (ref.worktreePath && !ref.isRemote && !map[ref.worktreePath]) map[ref.worktreePath] = ref.name;
          branches.set(map);
        })
        .catch(() => { if (serial === refsSerial) branches.set({}); });
    });
  });
  const seed = () => {
    if (locked()) return null;
    const current = project();
    return current ? resolvePreviousWorktreeSeed({ threads: allThreads().filter((thread) => thread.projectId === current.id), currentWorktreePath: activeWorktree(), branchOf: (path) => branches()[path] ?? null }) : null;
  };
  function usePrevious() {
    const found = seed();
    if (!found || !editable()) return;
    try { props.onSelectWorkspace({ type: "existing_worktree", worktreePath: found.worktreePath, ...(found.branch ? { branch: found.branch } : {}) }); error.set(""); }
    catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); }
  }
  // composer.previousWorktree
  let previousSeen = untracked(() => previousWorktreeRequests());
  effect(() => {
    const requests = previousWorktreeRequests();
    if (requests === previousSeen) return;
    previousSeen = requests;
    untracked(usePrevious);
  });

  function select(next: WorkspaceChoice) {
    if (!editable()) return;
    try { props.onSelectWorkspace(next); error.set(""); }
    catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); }
  }

  /** A server thread's branch is its own metadata; a new thread's is part of its workspace strategy. */
  function branchChanged(change: BranchChange) {
    const thread = openThread();
    if (!thread) return;
    if (isServerThread(thread.id)) {
      void request("orchestration.dispatchCommand", {
        type: "thread.metadata.update", commandId: `command:${crypto.randomUUID()}`, threadId: thread.id,
        branch: change.branch, worktreePath: change.worktreePath,
      }).catch((cause) => error.set(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    try {
      props.onSelectWorkspace(change.worktreePath
        ? { type: "existing_worktree", worktreePath: change.worktreePath, branch: change.branch }
        : { type: "root", branch: change.branch });
    } catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); }
  }

  /** "Checkout Pull request": the server checks the pull request out (a worktree while a new worktree is chosen) and the thread takes that branch. */
  // usePullRequestDraftThread openPullRequestDialog: "Checkout Pull request" opens PullRequestThreadDialog with the query.
  const pullRequestDialog = signal<{ key: number; reference: string } | null>(null);
  const dialogProvider = signal<string | null>(null);
  effect(() => {
    const cwd = pullRequestDialog() ? project()?.path ?? null : null;
    dialogProvider.set(null);
    if (!cwd) return;
    return watchVcsStatus(cwd, subscribeBackend, (next) => dialogProvider.set(next?.sourceControlProviderKind ?? null), () => {});
  });
  function preparedPullRequest(result: { branch: string; worktreePath: string | null }) {
    if (!result.branch) return;
    props.onSelectWorkspace(result.worktreePath
      ? { type: "existing_worktree", worktreePath: result.worktreePath, branch: result.branch }
      : { type: "root", branch: result.branch });
  }
  async function checkoutPullRequest(reference: string) {
    const thread = openThread();
    const cwd = project()?.path;
    if (!thread || !cwd || !editable()) return;
    error.set("");
    try {
      const result = (await request("git.preparePullRequestThread", { cwd, reference, mode: strategy().type === "worktree" ? "worktree" : "local", threadId: thread.id })) as { branch?: string; worktreePath?: string | null } | null;
      if (openThread()?.id !== thread.id || typeof result?.branch !== "string") return;
      props.onSelectWorkspace(typeof result.worktreePath === "string" && result.worktreePath
        ? { type: "existing_worktree", worktreePath: result.worktreePath, branch: result.branch }
        : { type: "root", branch: result.branch });
    } catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); }
  }

  /** shouldShowComposerContextStrip: a new thread always shows it; a started one only with the persist setting. */
  void loadSavedEnvironments();
  // "Run on": the connected environment and the saved ones the app can switch to.
  const savedEnvironmentOptions = () => buildEnvironmentOptions({
    connected: connected() && serverEnvironment() ? { id: String(serverEnvironment()?.environmentId ?? "primary"), label: String(serverEnvironment()?.label ?? "This machine") } : null,
    currentUrl: backendUrl(), saved: savedEnvironments(),
  });
  // useLogicalProjectEnvironments: with a project, the machines holding its checkout; without one, the saved list.
  const environmentOptions = () => project() ? logicalProjectEnvironments(project()) : savedEnvironmentOptions();
  const activeEnvironmentId = () => project() ? draftEnvironmentKey(project()) : savedEnvironmentOptions().find((item) => item.isPrimary)?.environmentId ?? null;
  const showStrip = () => shouldShowComposerContextStrip({
    isDraftHeroState: !locked(),
    persistInActiveThreads: settingValue("persistComposerContextStrip") === true && Boolean(project()?.path),
    hasActiveProject: project() !== undefined,
    showEnvironmentIndicator: shouldShowEnvironmentIndicator({ options: environmentOptions(), activeId: activeEnvironmentId() }) || canAutoBalance(),
  });
  // Compact mode (contextStripCompact.ts): labels collapse to icons when they need more room than the strip has.
  watchContextStrip(() => { if (!reduceMotion()) LayoutAnimation.configureNext({ duration: CONTEXT_LABEL_MS, update: { type: "easeOut", duration: CONTEXT_LABEL_MS } }); });
  const startFromOrigin = () => { const current = strategy(); return current.type === "worktree" && current.startFromOrigin === true; };
  return (
    <View class="w-full">
    {showStrip() ? (
    <View class="w-full gap-1 px-2 pt-2" accessibilityLabel="Workspace controls">
      <View class="w-full flex-row items-center gap-2">
        {shouldShowEnvironmentIndicator({ options: environmentOptions(), activeId: activeEnvironmentId() }) || canAutoBalance() ? (
          <EnvironmentSelector
            options={environmentOptions}
            activeId={activeEnvironmentId}
            locked={locked}
            disabled={() => !editable()}
            shortcutLabel={() => shortcutLabel("composer.host")}
            openRequests={hostMenuRequests}
            onSelect={(option) => { if (option.projectId !== undefined) { changeDraftEnvironment(environmentOptions(), option.environmentId); return; } chooseManualEnvironment(); if (option.url) configureBackend(option.url); }}
            autoLabel={autoEnvironmentLabel}
            onAuto={() => (!locked() && canAutoBalance() ? chooseAutoEnvironment : undefined)}
            addTargets={() => addProjectTargets(project() ?? null).map((machine) => ({ key: machine.key, label: machine.label, machine: machine.machine }))}
            onAddToMachine={(key) => { const current = project(); if (current) openAddProjectToMachine({ projectId: current.id, targetKey: key }); }}
          />
        ) : null}
        <EnvModeSelector
          strategy={strategy}
          locked={locked}
          lockedWorktree={() => Boolean(openThread()?.path)}
          activeWorktreePath={activeWorktree}
          disabled={() => !editable()}
          projectPath={() => project()?.path ?? null}
          seed={seed}
          onSelect={select}
          onUsePrevious={usePrevious}
          openRequests={workspaceMenuRequests}
          request={request}
        />
        <View class="min-w-0 flex-1" onLayout={(event) => reportContextStripSpacer(event.bounds.size.width)} testID="Context strip spacer" />
        <BranchSelector
          open={branchPickerOpen}
          cwd={() => activeWorktree() ?? project()?.path ?? null}
          projectCwd={() => project()?.path ?? null}
          activeWorktreePath={activeWorktree}
          branch={() => strategyBranch(strategy())}
          selectingWorktreeBase={() => !locked() && strategy().type === "worktree"}
          canCreate={connected}
          disabled={() => !connected() || isSending() || !openThread() || !project()?.path}
          request={request}
          onSelectBase={(refName) => { const current = strategy(); props.onSelectWorkspace({ type: "worktree", baseRef: refName, ...(current.type === "worktree" && current.startFromOrigin !== undefined ? { startFromOrigin: current.startFromOrigin } : {}) }); }}
          onBranchChanged={branchChanged}
          canChange={() => canWriteSourceControl() && canOperateThread()}
          onUnavailable={() => showToast({ type: "error", title: "Action unavailable", description: "This connection cannot change the thread's branch." })}
          onError={(message, action) => showToast({ type: "error", title: branchActionFailureTitle(action), description: message })}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={(checked) => { const current = strategy(); if (current.type === "worktree") props.onSelectWorkspace({ ...current, startFromOrigin: checked }); }}
          {...(!locked() ? { onCheckoutPullRequest: (reference: string) => { if (openThread()) pullRequestDialog.set({ key: Date.now(), reference }); } } : {})}
        />
        {pullRequestDialog() ? (
          <PullRequestThreadDialog
            open={() => pullRequestDialog() !== null}
            request={request}
            cwd={() => project()?.path ?? null}
            threadId={() => openThread()?.id ?? ""}
            initialReference={pullRequestDialog()!.reference}
            provider={() => dialogProvider()}
            onPrepared={preparedPullRequest}
            onClose={() => pullRequestDialog.set(null)}
          />
        ) : null}
        {!locked() ? (
          <StripPermissions
            runtime={runtimeMode}
            available={availableRuntimeModes}
            disabled={() => !editable()}
            onPick={(mode) => void setRuntimeMode(mode).catch((cause) => error.set(cause instanceof Error ? cause.message : String(cause)))}
          />
        ) : null}
      </View>
      {error() ? <Text class="text-xs text-error-foreground">{error()}</Text> : null}
    </View>
    ) : null}
    </View>
  );
}
