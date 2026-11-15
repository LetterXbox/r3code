// The composer strip's workspace control (BranchToolbarEnvModeSelector.tsx): a trigger naming the
// environment mode ("Current checkout", "Current worktree" or "New worktree") with a Workspace menu
// of Current checkout / New worktree / Previous worktree (the worktree the project's last thread ran
// in). A thread that has started shows the same row, locked, with the web's "Local checkout" /
// "Worktree" wording.
import { MiddleTruncate } from "../MiddleTruncate";
import { effect, signal, Text, untracked, View } from "nsh";
import { ComposerIcon } from "../composer/ComposerIcon";
import { createAnchor } from "../composer/Popover";
import { RadioMenu } from "../composer/RadioMenu";
import type { RadioMenuItem } from "../composer/RadioMenu";
import { envModeLabel, lockedEnvModeLabel, parseWorkspaceRefs } from "./workspaceRefs";
import type { PreviousWorktreeSeed, WorkspaceLike } from "./workspaceRefs";
import { ContextLabel } from "./ContextLabel";

type Choice = WorkspaceLike & { branch?: string; startFromOrigin?: boolean };

function modeIcon(strategy: Choice, activeWorktreePath: string | null): string {
  if (strategy.type === "worktree") return "folder-git-2";
  return activeWorktreePath ? "folder-git" : "folder";
}

export function EnvModeSelector(props: {
  strategy: () => Choice;
  locked: () => boolean;
  /** Where a started thread runs: its worktree, if it has one. */
  lockedWorktree: () => boolean;
  activeWorktreePath: () => string | null;
  disabled: () => boolean;
  projectPath: () => string | null;
  seed: () => PreviousWorktreeSeed | null;
  onSelect: (strategy: Choice) => void;
  onUsePrevious: () => void;
  /** composer.workspace: a counter that opens the menu each time it changes. */
  openRequests?: () => number;
  request: (method: string, payload: unknown) => Promise<unknown>;
}) {
  const open = signal(false);
  const loading = signal(false);
  const baseRef = signal<string | null>(null);
  const anchor = createAnchor();
  const triggerLabel = () => envModeLabel(props.strategy());
  const unavailable = () => props.disabled() || loading() || !props.projectPath();

  // The new worktree starts from the checkout's current ref, so it is read before the menu opens.
  async function show() {
    if (unavailable()) return;
    const cwd = props.projectPath();
    if (!cwd) return;
    loading.set(true);
    try {
      const refs = parseWorkspaceRefs(await props.request("vcs.listRefs", { cwd, limit: 100, refKind: "all" }));
      baseRef.set(refs.isRepo ? (refs.refs.find((ref) => ref.current && !ref.isRemote)?.name ?? refs.refs[0]?.name ?? null) : null);
    } catch { baseRef.set(null); }
    finally { loading.set(false); }
    open.set(true);
  }

  let seen = untracked(() => props.openRequests?.() ?? 0);
  effect(() => {
    const requests = props.openRequests?.() ?? 0;
    if (requests === seen) return;
    seen = requests;
    if (!props.locked()) untracked(() => { void show(); });
  });

  const items = (): RadioMenuItem[] => {
    const strategy = props.strategy();
    const seed = props.seed();
    const base = strategy.type === "worktree" ? strategy.baseRef : baseRef();
    const list: RadioMenuItem[] = [
      {
        value: "local", label: props.activeWorktreePath() ? "Current worktree" : "Current checkout",
        checked: strategy.type !== "worktree",
        onSelect: () => props.onSelect({ type: "root" }),
        content: (
          <View class="min-w-0 flex-row items-center gap-1.5">
            <ComposerIcon name={props.activeWorktreePath() ? "folder-git" : "folder"} size={12} />
            <Text class="min-w-0 truncate text-sm text-foreground">{props.activeWorktreePath() ? "Current worktree" : "Current checkout"}</Text>
          </View>
        ),
      },
      {
        value: "worktree", label: "New worktree", checked: strategy.type === "worktree", disabled: base === null,
        onSelect: () => { if (base !== null) props.onSelect({ type: "worktree", baseRef: base }); },
        content: (
          <View class="min-w-0 flex-row items-center gap-1.5">
            <ComposerIcon name="folder-git-2" size={12} />
            <Text class="min-w-0 truncate text-sm text-foreground">New worktree</Text>
          </View>
        ),
      },
    ];
    if (seed) {
      list.push({
        value: "previous-worktree", label: "Previous worktree", checked: false,
        onSelect: props.onUsePrevious,
        content: (
          <View class="min-w-0 flex-row items-start gap-1.5">
            <View class="mt-1"><ComposerIcon name="history" size={12} /></View>
            <View class="min-w-0 flex-1">
              <Text class="text-sm text-foreground">Previous worktree</Text>
              {seed.branch ? <MiddleTruncate value={seed.branch} textClass="text-xs text-muted-foreground" /> : null}
            </View>
          </View>
        ),
      });
    }
    return list;
  };

  const lockedRow = () => {
    const label = lockedEnvModeLabel(props.lockedWorktree());
    return (
      <View class="h-6 min-w-0 flex-row items-center gap-1.5 border border-transparent px-[7px]" accessibilityLabel="Workspace" accessibilityHint={label}>
        <ComposerIcon name={props.lockedWorktree() ? "folder-git" : "folder"} size={12} />
        <ContextLabel text={() => label} />
      </View>
    );
  };
  return (
    <View class="min-w-0 shrink">
      {props.locked() ? lockedRow() : (
        <View>
          <View
            ref={anchor.ref}
            class={`h-6 min-w-0 flex-row items-center gap-1.5 rounded-md border border-transparent px-[7px] ${open() ? "bg-accent" : "hover:bg-accent"} ${props.disabled() ? "opacity-64" : ""}`}
            disabled={unavailable()}
            onPress={() => { if (open()) open.set(false); else void show(); }}
            accessibilityLabel="Workspace"
            accessibilityHint={triggerLabel()}
            role="button"
          >
            <ComposerIcon name={modeIcon(props.strategy(), props.activeWorktreePath())} size={12} />
            <ContextLabel text={triggerLabel} />
          </View>
          {open() ? (
            <RadioMenu anchor={anchor.anchor} onClose={() => open.set(false)} group="Workspace" items={items} class={props.seed() ? "w-[336px]" : "w-56"} />
          ) : null}
        </View>
      )}
    </View>
  );
}
