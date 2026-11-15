// PullRequestLinkPreview: pressing a link to a pull request in a description or comment shows its card (repository and number,
// state, title, author and when it was opened) before anything opens. The web shows the card on hover over the link; a native
// text view reports presses, not hovers, so the card opens on the press and offers Open and Close.
import { keepPressInDialog } from "../dialogSurface";
import { Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { PRIcon } from "./PRIcon";
import { parsePullRequestLink, parsePullRequestPreview, previewAuthorLabel, type LinkedPullRequest, type PullRequestPreviewCard } from "./pullRequestLinkPreview.logic";
import { relativeTime, resolveState, toneColor } from "./pullRequestPresentation";
import { signal } from "nsh";
import { presenceStyle } from "../motion/Motion";
import { DURATION_DEFAULT_MS, popoverEnter, popoverExit } from "../motion/motionTokens";
import type { MotionSpec } from "nsh";

// ui/preview-card.tsx:33 `transition-[scale,opacity] data-starting-style:scale-98 data-starting-style:opacity-0`, 150ms: the card scales .98 to 1
// (the Dialog's own fade does the opacity).
const cardScaleEnter: MotionSpec = { ...popoverEnter, keyframes: { scale: [0.98, 1] } };
const cardScaleExit: MotionSpec = { ...popoverExit, keyframes: { scale: [1, 0.98] } };

export type LinkPreviewState =
  | { status: "loading"; url: string }
  | { status: "ready"; url: string; card: PullRequestPreviewCard }
  | { status: "failed"; url: string; message: string };

export function createPullRequestLinkPreviewModel(deps: {
  request: (method: string, payload: unknown) => Promise<unknown>;
  /** The project the open pull request belongs to: the link is read through it. */
  projectId: () => string | null;
  /** Opens a pull request inside the page when the host's link is one the list knows; false opens it on the host. */
  openInApp: (card: PullRequestPreviewCard) => boolean;
  openOnHost: (url: string) => void;
}) {
  const state = signal<LinkPreviewState | null>(null);
  let sequence = 0;
  /** True when the link is a pull request link this model took. */
  function handle(url: string): boolean {
    const link: LinkedPullRequest | null = parsePullRequestLink(url);
    const projectId = deps.projectId();
    if (!link || !projectId) return false;
    const mine = ++sequence;
    state.set({ status: "loading", url });
    void deps.request("pullRequests.preview", { projectId, host: link.host, repository: link.repository, number: link.number }).then(
      (answer) => { if (mine === sequence) state.set({ status: "ready", url, card: parsePullRequestPreview(answer) }); },
      (cause) => { if (mine === sequence) state.set({ status: "failed", url, message: cause instanceof Error ? cause.message : "Could not read this pull request." }); },
    );
    return true;
  }
  const close = () => { sequence++; state.set(null); };
  const open = () => {
    const current = state();
    if (!current) return;
    if (current.status === "ready" && deps.openInApp(current.card)) { close(); return; }
    deps.openOnHost(current.status === "ready" && current.card.url ? current.card.url : current.url);
    close();
  };
  return { state, handle, close, open };
}
export type PullRequestLinkPreviewModel = ReturnType<typeof createPullRequestLinkPreviewModel>;

export function PullRequestLinkPreview(props: { model: PullRequestLinkPreviewModel; now: () => number; scheme: "light" | "dark" }) {
  const current = () => props.model.state();
  useOverlayOpen(() => current() !== null, "pull request link preview", DURATION_DEFAULT_MS);
  const ready = () => { const value = current(); return value?.status === "ready" ? value : null; };
  const presentation = () => { const card = ready()?.card; return card ? resolveState({ state: card.state, isDraft: card.isDraft }) : null; };
  return (
    <Dialog open={current() !== null} animation="fade" onOpenChange={({ open }) => { if (!open) props.model.close(); }} backdropClass="bg-transparent" style={[{ margin: "auto", width: 320, maxWidth: "92%" }, presenceStyle(cardScaleEnter, cardScaleExit, () => current() !== null)]}>
      <View class="flex-col gap-2 rounded-lg border border-border bg-popover p-3" accessibilityLabel="Pull request preview" onPress={keepPressInDialog}>
        {current()?.status === "loading" ? <Text class="text-xs text-muted-foreground">Loading pull request...</Text> : null}
        {current()?.status === "failed" ? <Text class="text-xs text-muted-foreground">{(current() as { message: string }).message}</Text> : null}
        {ready() ? (
          <View class="min-w-0 flex-col">
            <View class="min-w-0 flex-row items-center gap-1.5">
              <Text class="min-w-0 truncate text-2xs text-muted-foreground">{ready()!.card.repository}</Text>
              <Text class="shrink-0 text-2xs text-muted-foreground">{`#${ready()!.card.number}`}</Text>
              <Text class="text-2xs text-muted-foreground">·</Text>
              {presentation() ? <View class="shrink-0 flex-row items-center gap-1"><PRIcon name={presentation()!.icon} size={12} tint={toneColor(presentation()!.tone, props.scheme)} /><Text class="text-2xs text-muted-foreground">{presentation()!.label}</Text></View> : null}
            </View>
            <Text class="mt-1 text-sm font-medium text-foreground">{ready()!.card.title}</Text>
            <View class="mt-2 min-w-0 flex-row items-center gap-1.5">
              <Text class="min-w-0 truncate text-xs text-muted-foreground">{previewAuthorLabel(ready()!.card.author)}</Text>
              {ready()!.card.createdAt ? <><Text class="text-xs text-muted-foreground">·</Text><Text class="shrink-0 text-xs text-muted-foreground">{`opened ${relativeTime(ready()!.card.createdAt, props.now())}`}</Text></> : null}
            </View>
          </View>
        ) : null}
        <View class="mt-1 flex-row items-center justify-end gap-2">
          <View role="button" accessibilityLabel="Close preview" onPress={props.model.close} class="h-6 flex-row items-center rounded-md px-2 hover:bg-accent-50"><Text class="text-xs text-foreground">Close</Text></View>
          <View role="button" accessibilityLabel="Open linked pull request" onPress={props.model.open} class="h-6 flex-row items-center rounded-md border border-border px-2 hover:bg-accent-50"><Text class="text-xs text-foreground">Open</Text></View>
        </View>
      </View>
    </Dialog>
  );
}
