// ThreadNow.tsx ThreadSyncLine: the line at the end of the timeline while a thread's messages load. useDelayedStatus holds it
// back (400 ms) so a quick load never flashes it, then keeps it up for at least 400 ms.
import { effect, signal, Text, token, View } from "nsh";
import { BannerIcon } from "../../banners/BannerIcon";
import { chatWidthClass } from "../layout";
import { threadSyncPhase } from "../../../store";

export const THREAD_SYNC_SHOW_DELAY_MS = 400;
export const THREAD_SYNC_MIN_VISIBLE_MS = 400;

/** threadSync.ts threadSyncLabel. */
export const threadSyncLabel = (phase: "loading" | "syncing") => (phase === "loading" ? "Loading messages..." : "Syncing messages...");

export function ThreadSyncLine(props: { phase?: () => "loading" | "syncing" | null } = {}) {
  const phase = props.phase ?? threadSyncPhase;
  const shown = signal<"loading" | "syncing" | null>(null);
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let shownAt = 0;
  effect(() => {
    const current = phase();
    clearTimeout(showTimer);
    if (current !== null) {
      clearTimeout(holdTimer);
      if (shown() === null) showTimer = setTimeout(() => { shownAt = Date.now(); shown.set(current); }, THREAD_SYNC_SHOW_DELAY_MS);
      else shown.set(current);
    } else if (shown() !== null) {
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => shown.set(null), Math.max(0, THREAD_SYNC_MIN_VISIBLE_MS - (Date.now() - shownAt)));
    }
  });
  effect(() => () => { clearTimeout(showTimer); clearTimeout(holdTimer); });
  return (
    <If when={shown()}>
      {(value) => (
        <View class="shrink-0 px-3">
          <View testID="Thread sync line" accessibilityLabel={threadSyncLabel(value())} class={`mx-auto w-full ${chatWidthClass()} min-w-0 flex-row items-baseline gap-1.5 px-1 pb-2`}>
            <View class="size-3.5 shrink-0 self-center items-center justify-center"><BannerIcon name="refresh-cw" size={14} tint={token("muted-foreground")} /></View>
            <Text class="min-w-0 shrink truncate text-xs text-muted-foreground">{threadSyncLabel(value())}</Text>
          </View>
        </View>
      )}
    </If>
  );
}
