// PullRequestThreadDialog.tsx (opened by the branch picker's "Checkout Pull request", usePullRequestDraftThread):
// the typed reference resolves through git.resolvePullRequest (450 ms debounce, answers cached per cwd + reference),
// the resolved request shows as a card, and Local / Worktree prepare the thread with git.preparePullRequestThread.
import { effect, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { DialogInput as Input } from "../DialogInput";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { DIALOG_MS } from "../motion/motionTokens";
import { HIcon } from "../header/HeaderIcons";
import { changeRequestIconName } from "../header/gitLogic";
import { offHeadPullRequestCheckoutToast } from "../pullRequest/pullRequestCheckoutToast";
import { showToast } from "../toast";
import { parsePullRequestReference } from "./branchLogic";
import { DialogCloseButton } from "../DialogCloseButton";

type Request = (method: string, payload: unknown) => Promise<unknown>;
export interface ResolvedPullRequest { number: number; title: string; url: string; baseBranch: string; headBranch: string; state: string }

/** getSourceControlPresentation: the provider's name and its word for a change request. */
export function sourceControlTerminology(provider: string | null) {
  if (provider === "gitlab") return { providerName: "GitLab", singular: "merge request", shortLabel: "MR" };
  if (provider === "github") return { providerName: "GitHub", singular: "pull request", shortLabel: "PR" };
  if (provider === "bitbucket") return { providerName: "Bitbucket", singular: "pull request", shortLabel: "PR" };
  if (provider === "azure-devops") return { providerName: "Azure DevOps", singular: "pull request", shortLabel: "PR" };
  return { providerName: "source control", singular: "pull request", shortLabel: "PR" };
}

function readResolution(value: unknown): ResolvedPullRequest | null {
  const pr = value && typeof value === "object" ? (value as { pullRequest?: unknown }).pullRequest : null;
  if (!pr || typeof pr !== "object") return null;
  const raw = pr as Record<string, unknown>;
  return typeof raw.number === "number" && typeof raw.title === "string"
    ? { number: raw.number, title: raw.title, url: String(raw.url ?? ""), baseBranch: String(raw.baseBranch ?? ""), headBranch: String(raw.headBranch ?? ""), state: String(raw.state ?? "") }
    : null;
}

// readCachedPullRequestResolution: an answer for the same cwd and reference shows at once.
const resolutions = new Map<string, ResolvedPullRequest>();
const resolutionKey = (cwd: string, reference: string) => JSON.stringify([cwd, reference]);
export function resetPullRequestResolutionsForTest() { resolutions.clear(); }

export function createPullRequestThreadDialogModel(deps: {
  request: Request;
  cwd: () => string | null;
  threadId: () => string;
  initialReference: string | null;
  open: () => boolean;
  terminology: () => ReturnType<typeof sourceControlTerminology>;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
  onClose: () => void;
  debounceMs?: number;
}) {
  const reference = signal(deps.initialReference ?? "");
  const dirty = signal(false);
  const debounced = signal(reference());
  const debouncing = signal(false);
  const resolved = signal<ResolvedPullRequest | null>(null);
  const resolving = signal(false);
  const resolutionError = signal<string | null>(null);
  const preparing = signal<"local" | "worktree" | null>(null);
  const checkoutError = signal<{ target: string; message: string } | null>(null);

  effect(() => {
    const value = reference();
    debouncing.set(true);
    const timer = setTimeout(() => { debounced.set(value); debouncing.set(false); }, deps.debounceMs ?? 450);
    return () => clearTimeout(timer);
  });
  effect(() => {
    const parsed = deps.open() ? parsePullRequestReference(debounced()) : null;
    const cwd = deps.cwd();
    resolutionError.set(null);
    if (!parsed || !cwd) { resolved.set(null); resolving.set(false); return; }
    let live = true;
    resolving.set(true);
    void deps.request("git.resolvePullRequest", { cwd, reference: parsed }).then((value) => {
      if (!live) return;
      const pr = readResolution(value);
      if (pr) resolutions.set(resolutionKey(cwd, parsed), pr);
      resolved.set(pr);
    }, (cause: unknown) => {
      if (!live) return;
      resolved.set(null);
      resolutionError.set(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (live) resolving.set(false); });
    return () => { live = false; };
  });

  const parsedReference = () => parsePullRequestReference(reference());
  const cached = () => { const parsed = parsedReference(); const cwd = deps.cwd(); return parsed && cwd ? resolutions.get(resolutionKey(cwd, parsed)) ?? null : null; };
  const resolvedPullRequest = () => (parsedReference() !== null && parsedReference() === parsePullRequestReference(debounced()) ? resolved() : null) ?? cached();
  const isResolving = () => deps.open() && parsedReference() !== null && resolvedPullRequest() === null
    && (debouncing() || parsedReference() !== parsePullRequestReference(debounced()) || resolving());
  const validationMessage = () => {
    if (!dirty()) return null;
    const term = deps.terminology().singular;
    if (reference().trim().length === 0) return `Paste a ${term} URL, checkout command, or enter 123 / #123.`;
    return parsedReference() === null ? `Use a ${term} URL, checkout command, 123, or #123.` : null;
  };
  const checkoutTarget = () => JSON.stringify([deps.cwd(), deps.threadId(), parsedReference()]);
  const errorMessage = () => validationMessage() ?? (checkoutError()?.target === checkoutTarget() ? checkoutError()!.message : null) ?? (resolvedPullRequest() === null ? resolutionError() : null);
  const canConfirm = () => deps.cwd() !== null && resolvedPullRequest() !== null && !isResolving() && preparing() === null;

  async function confirm(mode: "local" | "worktree") {
    const parsed = parsedReference();
    if (!parsed) { dirty.set(true); return; }
    const cwd = deps.cwd();
    if (!resolvedPullRequest() || !cwd || preparing() !== null) return;
    const target = checkoutTarget();
    checkoutError.set(null);
    preparing.set(mode);
    let result: { branch?: unknown; worktreePath?: unknown; isOnPullRequestHead?: unknown } | null;
    try {
      result = (await deps.request("git.preparePullRequestThread", { cwd, reference: parsed, mode, ...(mode === "worktree" ? { threadId: deps.threadId() } : {}) })) as typeof result;
    } catch (cause) {
      preparing.set(null);
      checkoutError.set({ target, message: cause instanceof Error ? cause.message : `Failed to prepare ${deps.terminology().singular} thread.` });
      return;
    }
    preparing.set(null);
    await deps.onPrepared({ branch: String(result?.branch ?? ""), worktreePath: typeof result?.worktreePath === "string" ? result.worktreePath : null });
    if (result?.isOnPullRequestHead === false) showToast(offHeadPullRequestCheckoutToast(deps.terminology().singular));
    deps.onClose();
  }

  return { reference, dirty, resolvedPullRequest, isResolving, errorMessage, canConfirm, confirm, preparing };
}

// pullRequestStatusTone: violet / zinc / emerald, as hex because the theme has no such tokens.
const STATUS_TONE: Record<string, string> = { merged: "#c4b5fd", closed: "#a1a1aa", open: "#6ee7b7" };
const buttonClass = "h-8 items-center justify-center rounded-lg px-3";

export function PullRequestThreadDialog(props: {
  open: () => boolean;
  request: Request;
  cwd: () => string | null;
  threadId: () => string;
  initialReference: string | null;
  provider: () => string | null;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
  onClose: () => void;
  debounceMs?: number;
}) {
  useOverlayOpen(() => props.open(), "pull request thread dialog", DIALOG_MS);
  const terminology = () => sourceControlTerminology(props.provider());
  const model = createPullRequestThreadDialogModel({ ...props, terminology });
  const close = () => { if (model.preparing() === null) props.onClose(); };
  const pr = () => model.resolvedPullRequest();
  return (
    <Dialog
      open={props.open()}
      animation="fade"
      onOpenChange={({ open }) => { if (!open) close(); }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 576, maxWidth: "92%" }, dialogPopupMotion(props.open)]}
    >
      <View class="relative overflow-hidden rounded-2xl border border-border bg-background" role="group" accessibilityLabel={`Checkout ${terminology().singular}`} onPress={keepPressInDialog}>
        <DialogCloseButton onClose={close} />
        <View class="gap-1.5 px-6 pb-4 pt-6">
          <View class="flex-row items-center">
            <View class="me-2"><HIcon name={changeRequestIconName(props.provider())} size={16} /></View>
            <Text class="text-lg font-semibold text-foreground">{`Checkout ${terminology().singular}`}</Text>
          </View>
          <Text class="text-sm text-muted-foreground">{`Resolve a ${terminology().providerName} ${terminology().singular}, then create the draft thread in the main repo or in a dedicated worktree.`}</Text>
        </View>
        <View class="gap-4 bg-card-40 px-6 py-5">
          <View class="gap-1.5">
            <Text class="text-xs font-medium capitalize text-foreground">{terminology().singular}</Text>
            <Input
              class="h-8 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
              placeholder={`${terminology().shortLabel} URL, checkout command, or #42`}
              value={model.reference()}
              accessibilityLabel={terminology().singular}
              onChange={(event) => { model.dirty.set(true); model.reference.set(event.value); }}
              onSubmit={() => { if (!model.isResolving() && model.preparing() === null) void model.confirm("worktree"); }}
            />
          </View>
          {pr() ? (
            <View class="rounded-xl border border-border-70 bg-muted-30 p-3">
              <View class="flex-row items-start justify-between gap-3">
                <View class="min-w-0 flex-1">
                  <Text class="truncate text-sm font-medium text-foreground">{pr()!.title}</Text>
                  <Text class="truncate text-xs text-muted-foreground">{`#${pr()!.number} · ${pr()!.headBranch} to ${pr()!.baseBranch}`}</Text>
                </View>
                <Text class={`shrink-0 text-xs capitalize ${STATUS_TONE[pr()!.state] ? "" : "text-muted-foreground"}`} style={STATUS_TONE[pr()!.state] ? { color: STATUS_TONE[pr()!.state] } : undefined}>{pr()!.state}</Text>
              </View>
            </View>
          ) : null}
          {model.isResolving() ? <Text class="text-xs text-muted-foreground">{`Resolving ${terminology().singular}...`}</Text> : null}
          {model.errorMessage() ? <Text class="text-xs text-destructive">{model.errorMessage()}</Text> : null}
        </View>
        <View class="flex-row justify-end gap-2 border-t border-border px-6 py-4">
          <View role="button" accessibilityLabel="Cancel" disabled={model.preparing() !== null} onPress={close} class={`${buttonClass} border border-input hover:bg-accent`}>
            <Text class="text-sm text-foreground">Cancel</Text>
          </View>
          <View role="button" accessibilityLabel="Local" disabled={!model.canConfirm()} onPress={() => void model.confirm("local")} class={`${buttonClass} border border-input ${model.canConfirm() ? "hover:bg-accent" : "opacity-64"}`}>
            <Text class="text-sm text-foreground">{model.preparing() === "local" ? "Preparing local..." : "Local"}</Text>
          </View>
          <View role="button" accessibilityLabel="Worktree" disabled={!model.canConfirm()} onPress={() => void model.confirm("worktree")} class={`${buttonClass} bg-primary ${model.canConfirm() ? "" : "opacity-64"}`}>
            <Text class="text-sm font-medium text-primary-foreground">{model.preparing() === "worktree" ? "Preparing worktree..." : "Worktree"}</Text>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
