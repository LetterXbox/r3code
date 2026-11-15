// BranchToolbar's run-context row in the thread details card (RunContextSelector, displayMode="panel") for a thread
// that has not started: one row naming the machine (when there is more than one to choose from) or the workspace,
// with a menu under it of "Run on" (the machines) and "Workspace" (Current checkout, New worktree, Previous
// worktree). A started thread's row is the locked EnvironmentRow in ThreadDetailsSections.
import { effect, signal, Text, untracked, View } from "nsh";
import { createAnchor, Popup } from "../composer/Popover";
import { envModeLabel, parseWorkspaceRefs, previousWorktreeLabel, type PreviousWorktreeSeed, type WorkspaceLike } from "../thread/workspaceRefs";
import type { EnvironmentOption } from "../thread/environmentOptions";
import { HIcon } from "./HeaderIcons";
import { MACHINE_ICON, runContextLabel } from "./detailsLogic";
import type { Request } from "./gitRuntime";
import { MENU_ITEM_ROW_CLASS } from "../menuStyles";

type Strategy = WorkspaceLike & { branch?: string; startFromOrigin?: boolean };

/** The mark of the workspace: a new worktree, an existing one, or the checkout. */
export function workspaceMark(strategy: Strategy, activeWorktreePath: string | null): string {
  if (strategy.type === "worktree") return "folder-git-2";
  return activeWorktreePath ? "folder-git" : "folder";
}

/** The label of the "Current ..." row. */
export const currentWorkspaceLabel = (activeWorktreePath: string | null) => (activeWorktreePath ? "Current worktree" : "Current checkout");

const rowClass = "h-8 w-full flex-row items-center gap-2.5 rounded-lg px-2.5 hover:bg-details-row-hover";

export function RunContextRow(props: {
  strategy: () => Strategy;
  onSelectWorkspace: (strategy: Strategy) => void;
  activeWorktreePath: () => string | null;
  projectPath: () => string | null;
  /** The worktree the project's last thread ran in, with its branch when the refs name it. */
  seed: (branchOf: (worktreePath: string) => string | null) => PreviousWorktreeSeed | null;
  /** The machines to run on; the row names the active one when there is more than one. */
  environments: () => EnvironmentOption[];
  activeEnvironmentId: () => string | null;
  onSelectEnvironment: (option: EnvironmentOption) => void;
  /** A thread that is sending, or no connection, cannot change its run context. */
  disabled: () => boolean;
  request: Request;
  /** composer.host / composer.workspace style requests are not wired here; the card opens the menu by press only. */
  onOpenChange?: (open: boolean) => void;
}) {
  const open = signal(false);
  const loading = signal(false);
  const baseRef = signal<string | null>(null);
  const worktreeBranches = signal<Record<string, string>>({});
  const error = signal<string | null>(null);
  const anchor = createAnchor();
  effect(() => { const isOpen = open(); untracked(() => props.onOpenChange?.(isOpen)); });

  const showEnvironment = () => props.environments().length > 1;
  const activeEnvironment = () => props.environments().find((option) => option.environmentId === props.activeEnvironmentId()) ?? null;
  const workspaceLabel = () => envModeLabel(props.strategy());
  const label = () => (showEnvironment() ? activeEnvironment()?.label ?? "Run on" : workspaceLabel());
  const seed = () => props.seed((path) => worktreeBranches()[path] ?? null);
  const unavailable = () => props.disabled() || loading() || !props.projectPath();

  // The new worktree starts from the checkout's current ref, and a previous worktree is named by its branch: both come from the refs.
  async function show() {
    if (unavailable()) return;
    const cwd = props.projectPath();
    if (!cwd) return;
    loading.set(true);
    error.set(null);
    try {
      const refs = parseWorkspaceRefs(await props.request("vcs.listRefs", { cwd, limit: 100, refKind: "all" }));
      baseRef.set(refs.isRepo ? (refs.refs.find((ref) => ref.current && !ref.isRemote)?.name ?? refs.refs[0]?.name ?? null) : null);
      const map: Record<string, string> = {};
      for (const ref of refs.refs) if (ref.worktreePath && !ref.isRemote && !map[ref.worktreePath]) map[ref.worktreePath] = ref.name;
      worktreeBranches.set(map);
    } catch { baseRef.set(null); }
    finally { loading.set(false); }
    open.set(true);
  }
  function select(next: Strategy) {
    try { props.onSelectWorkspace(next); error.set(null); }
    catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); }
  }

  const itemClass = (checked: boolean, disabled = false) => `${MENU_ITEM_ROW_CLASS} ${checked ? "bg-accent-50" : ""} ${disabled ? "opacity-64" : ""}`;
  const workspaceItems = () => {
    const strategy = props.strategy();
    const base = strategy.type === "worktree" ? strategy.baseRef : baseRef();
    const previous = seed();
    return [
      { value: "local", label: currentWorkspaceLabel(props.activeWorktreePath()), checked: strategy.type !== "worktree", disabled: false, icon: props.activeWorktreePath() ? "folder-git" : "folder", run: () => select({ type: "root" }) },
      { value: "worktree", label: "New worktree", checked: strategy.type === "worktree", disabled: base === null, icon: "folder-git-2", run: () => { if (base !== null) select({ type: "worktree", baseRef: base }); } },
      ...(previous ? [{ value: "previous-worktree", label: previousWorktreeLabel(previous), checked: false, disabled: false, icon: "folder-git", run: () => select({ type: "existing_worktree", worktreePath: previous.worktreePath, ...(previous.branch ? { branch: previous.branch } : {}) }) }] : []),
    ];
  };

  const rowLabel = () => runContextLabel(workspaceLabel(), showEnvironment() ? activeEnvironment()?.label : undefined);
  return (
    <View class="w-full">
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel={rowLabel()}
        disabled={unavailable()}
        onPress={() => { if (open()) open.set(false); else void show(); }}
        class={`${rowClass} ${open() ? "bg-details-row-hover" : ""} ${props.disabled() ? "opacity-64" : ""}`}
      >
        {showEnvironment()
          ? <HIcon name={MACHINE_ICON[activeEnvironment()?.machine ?? "server"] ?? "server"} size={18} />
          : <HIcon name={workspaceMark(props.strategy(), props.activeWorktreePath())} size={16} />}
        <Text class="min-w-0 flex-1 truncate text-[13px] font-medium text-details-label">{label()}</Text>
        {/* Trailing in the panel, so every row label starts on the same edge. */}
        {showEnvironment() ? <HIcon name={workspaceMark(props.strategy(), props.activeWorktreePath())} size={16} /> : null}
      </View>
      {error() ? <Text class="px-2.5 pt-1 text-xs text-error-foreground">{error()}</Text> : null}
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="start" class="w-[264px]">
          <View class="p-1" role="menu" accessibilityLabel="Run context">
            {showEnvironment() ? (
              <>
                <Text class="px-2 py-1.5 text-xs font-medium text-muted-foreground">Run on</Text>
                <Each of={props.environments()} key={(option) => option.environmentId}>
                  {(option) => (
                    <View role="menuitemradio" accessibilityLabel={option().label} accessibilityState={{ checked: option().environmentId === props.activeEnvironmentId() }} class={itemClass(option().environmentId === props.activeEnvironmentId())} onPress={() => { open.set(false); props.onSelectEnvironment(option()); }}>
                      <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                        <HIcon name={MACHINE_ICON[option().machine] ?? "server"} size={12} />
                        <Text class="min-w-0 truncate text-sm text-foreground">{option().label}</Text>
                      </View>
                    </View>
                  )}
                </Each>
                <View class="my-1 h-px bg-border" />
              </>
            ) : null}
            <Text class="px-2 py-1.5 text-xs font-medium text-muted-foreground">Workspace</Text>
            <Each of={workspaceItems()} key={(item) => item.value}>
              {(item) => (
                <View role="menuitemradio" accessibilityLabel={item().label} accessibilityState={{ checked: item().checked, disabled: item().disabled }} disabled={item().disabled} class={itemClass(item().checked, item().disabled)} onPress={() => { if (!item().disabled) { open.set(false); item().run(); } }}>
                  <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                    <HIcon name={item().icon} size={12} />
                    <Text class="min-w-0 truncate text-sm text-foreground">{item().label}</Text>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </Popup>
      ) : null}
    </View>
  );
}
