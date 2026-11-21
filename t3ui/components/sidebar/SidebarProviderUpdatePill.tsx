// SidebarProviderUpdatePill: a min-h-7 pill above the footer buttons, text-2xs font-medium. A
// spinner while an update runs, a check, a warning triangle or a download mark by outcome, the
// title, and an X on results the user can dismiss. A click opens the Providers settings.
import { colorScheme, effect, signal, Text, token, View } from "nsh";
import { openSettings, providerStatuses } from "../../store";
import { Glyph } from "./SidebarGlyph";
import { mixColors } from "./mix";
import { getProviderUpdatePillView, latestProviderCheckedAt } from "./providerUpdatePill";
import { Spinner } from "./Spinner";
import { Tip } from "./Tip";
import { enterStyle, Presence, presenceStyle } from "../motion/Motion";
import { createPillSwap } from "./providerPillSwap";
import { cssEasing, dismissDrain, EASE_DRAWER, MOTION_AT_REST, PROVIDER_PILL_MS, providerPillExit } from "../motion/motionTokens";

const dismissed = signal<ReadonlySet<string>>(new Set());
// Results older than the first look at the providers are history, not news.
const visibleAfter = signal<string | undefined>(undefined);

export const providerUpdateView = () => {
  const providers = providerStatuses();
  const after = visibleAfter() ?? latestProviderCheckedAt(providers);
  return getProviderUpdatePillView(providers, { ...(after !== undefined ? { visibleAfterIso: after } : {}), dismissedKeys: dismissed() });
};

export function ProviderUpdatePill() {
  // The first non-empty provider list fixes the baseline.
  effect(() => {
    const providers = providerStatuses();
    if (visibleAfter() === undefined) {
      const at = latestProviderCheckedAt(providers);
      if (at !== undefined) visibleAfter.set(at);
    }
  });
  const addDismissed = (target: { key: string; dismissKeys?: string[] }) => {
    dismissed.update((keys) => {
      const next = new Set(keys);
      for (const k of target.dismissKeys ?? [target.key]) next.add(k);
      return next;
    });
  };
  // A success clears itself after a few seconds.
  effect(() => {
    const view = providerUpdateView();
    if (!view?.dismissAfterVisibleMs) return;
    const timer = setTimeout(() => addDismissed(view), view.dismissAfterVisibleMs);
    return () => clearTimeout(timer);
  });
  const style = () => {
    colorScheme();
    const tone = swap.shown()?.tone;
    if (tone === "warning") return { backgroundColor: mixColors(token("warning"), token("sidebar"), 0.12), color: token("warning-foreground") };
    if (tone === "error") return { backgroundColor: mixColors(token("destructive"), token("sidebar"), 0.12), color: token("destructive-foreground") };
    return { backgroundColor: token("sidebar-control-surface"), color: token("sidebar-foreground") };
  };
  // SidebarProviderUpdatePill.tsx:143-160: colours change over 180ms ease-drawer; a pill that goes away slides 6pt down and
  // fades over the same 180ms (inert meanwhile); a result that dismisses itself drains a progress bar (scaleX 1 to 0, linear)
  // over its visible time. The exit keeps showing the last view.
  // A view whose key changes plays the same exit before the next one shows (providerPillSwap.ts).
  const swap = createPillSwap(providerUpdateView, PROVIDER_PILL_MS);
  const view = swap.shown;
  return (
    <Presence when={() => swap.shown() !== null} ms={0}>{() => {
      const closing = swap.leaving;
      return (
      <View
        class="min-h-7 w-full flex-row items-center overflow-hidden rounded-lg transition-colors duration-180"
        style={[{ backgroundColor: style().backgroundColor, transitionTimingFunction: cssEasing(EASE_DRAWER) }, closing() ? { pointerEvents: "none" } : null, presenceStyle(MOTION_AT_REST, providerPillExit, () => !closing())]}
      >
        {view()?.dismissAfterVisibleMs && view()?.tone !== "loading" && !closing() ? (
          <View class="absolute inset-y-0 left-0 w-full" style={[{ transformOrigin: "left", backgroundColor: view()!.tone === "success" ? token("foreground") : style().color, opacity: view()!.tone === "success" ? 0.08 : 0.14, pointerEvents: "none" }, enterStyle(dismissDrain(view()!.dismissAfterVisibleMs!))]} />
        ) : null}
        <View
          role="button"
          accessibilityLabel={view()!.description}
          tooltip={<Tip label={view()!.description} />}
          class="min-w-0 flex-1 flex-row items-center gap-2 px-2 py-1.5"
          onPress={() => openSettings("/settings/providers")}
        >
          {view()!.tone === "loading"
            ? <Spinner size={14} tint={style().color} />
            : view()!.tone === "success"
              ? <Glyph name="circle-check" size={14} tint={style().color} />
              : view()!.tone === "error"
                ? <Glyph name="triangle-alert" size={14} tint={style().color} />
                : <Glyph name="download" size={14} tint={style().color} />}
          <Text class="min-w-0 flex-1 text-2xs font-medium" style={{ color: style().color }}>{view()!.title}</Text>
        </View>
        {view()!.dismissible ? (
          <View
            role="button"
            accessibilityLabel="Dismiss provider update notice"
            tooltip={<Tip label="Dismiss until provider status changes" />}
            class="mr-1 size-5 items-center justify-center rounded-md"
            onPress={() => addDismissed(view()!)}
          >
            <Glyph name="x" size={14} tint={style().color} />
          </View>
        ) : null}
      </View>
      );
    }}</Presence>
  );
}
