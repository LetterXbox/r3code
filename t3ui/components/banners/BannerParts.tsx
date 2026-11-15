// The painted parts shared by the lane, the composer stack and the thread-now lines: an action button, the
// notice card (ComposerBannerStack's NoticeCard on ComposerBanner.Root) and the glass lane alert (ui/alert.tsx).
import { effect, signal, Text, token, View } from "nsh";
import { Tooltip } from "nsh/base";
import { createHover } from "../hoverReveal";
import { createAnchor, Popup } from "../composer/Popover";
import { tokenOver } from "../composer/tokenColor";
import { BannerIcon, type BannerIconName } from "./BannerIcon";
import type { BannerAction, BannerItem, BannerVariant, LaneAlert } from "./bannerTypes";
import { formatDuration } from "./bannerLogic";

export function BannerTip(props: { text: string }) {
  return <Tooltip class="max-w-[420px] rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

/** A Button size xs (outline for a primary action, ghost inside a notice) or an InlineButton. */
export function BannerActionButton(props: { action: BannerAction; surface?: "alert" | "notice" }) {
  const action = () => props.action;
  const tone = () => action().tone ?? "button";
  const hover = createHover();
  return tone() === "button" ? (
    <View
      role="button"
      accessibilityLabel={action().label}
      disabled={action().disabled}
      tooltip={action().title ? <BannerTip text={action().title!} /> : undefined}
      onPress={() => { if (!action().disabled) action().run(); }}
      class={`h-6 shrink-0 flex-row items-center justify-center rounded-md px-2 ${props.surface === "notice" ? "hover:bg-accent" : "border border-border hover:bg-accent"} ${action().disabled ? "opacity-64" : ""}`}
    >
      <Text class="text-xs font-medium text-foreground">{action().label}</Text>
    </View>
  ) : (
    <View
      role="button"
      accessibilityLabel={action().label}
      disabled={action().disabled}
      onPress={() => { if (!action().disabled) action().run(); }}
      class={`shrink-0 ${action().disabled ? "opacity-64" : ""}`}
      {...hover.bind}
    >
      <Text class={`text-xs font-medium ${hover.hovered() ? "underline" : ""} ${tone() === "muted" ? "text-muted-foreground" : "text-foreground"}`}>{action().label}</Text>
    </View>
  );
}

export function DismissButton(props: { label: string; onPress: () => void }) {
  return (
    <View role="button" accessibilityLabel={props.label} onPress={props.onPress} class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
      <BannerIcon name="x" size={14} />
    </View>
  );
}

const iconTint = (variant: BannerVariant) => (variant === "warning" ? token("warning") : variant === "error" ? token("error") : token("muted-foreground"));

/** A notice attached above the composer: an icon column, the title with its detail dimmed, the actions, a dismiss. */
export function NoticeCard(props: { item: BannerItem; first: boolean; last: boolean }) {
  const item = () => props.item;
  const border = () => (item().variant === "error" ? "border-error" : item().variant === "warning" ? "border-warning" : "border-border");
  const tint = () => (item().variant === "error" ? "bg-error-surface" : item().variant === "warning" ? "bg-warning-surface" : "bg-card");
  return (
    <View
      testID="Composer notice"
      role={item().variant === "error" || item().variant === "warning" ? "alert" : undefined}
      accessibilityLabel={item().title}
      class={`mx-3 min-w-0 flex-row items-center gap-1 border border-b-0 px-1 py-1.5 ${border()} ${tint()} ${props.first ? "rounded-t-2xl" : ""}`}
    >
      <View class="size-6 shrink-0 items-center justify-center"><BannerIcon name={item().icon} size={12} tint={iconTint(item().variant)} /></View>
      <View class="min-w-0 flex-1 flex-row items-center gap-1" tooltip={item().description ? <BannerTip text={`${item().title}. ${item().description}`} /> : undefined}>
        {item().titlePopover ? <TitlePopover title={item().title} popover={item().titlePopover!} /> : <Text class="min-w-0 shrink truncate text-xs font-medium text-foreground">{item().title}</Text>}
        {item().description ? <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item().description}</Text> : null}
      </View>
      <View class="shrink-0 flex-row items-center gap-1">
        <Each of={item().actions} key={(action) => action.id}>{(action) => <BannerActionButton action={action()} surface="notice" />}</Each>
        {item().onDismiss ? <DismissButton label={item().dismissLabel ?? "Dismiss warning"} onPress={() => item().onDismiss?.()} /> : null}
      </View>
    </View>
  );
}

/** The title as an InlineButton opening a popover (PopoverPopup side="top" align="start" width="md"): each row's label, then its detail dimmed. */
function TitlePopover(props: { title: string; popover: NonNullable<BannerItem["titlePopover"]> }) {
  const open = signal(false);
  const anchor = createAnchor();
  const hover = createHover();
  return (
    <View ref={anchor.ref} class="min-w-0 shrink" role="button" accessibilityLabel={props.popover.accessibilityLabel} onPress={() => open.update((value) => !value)} {...hover.bind}>
      <Text class={`min-w-0 truncate text-xs font-medium text-foreground ${hover.hovered() || open() ? "underline" : ""}`}>{props.title}</Text>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="top" align="start" class="w-80">
          <View class="w-80 gap-3 p-3">
            <Each of={props.popover.rows} key={(row) => row.key}>{(row) => (
              <View class="gap-1">
                <Text class="text-xs font-medium text-popover-foreground">{row().label}</Text>
                <Text class="text-xs text-muted-foreground">{row().detail}</Text>
              </View>
            )}</Each>
          </View>
        </Popup>
      ) : null}
    </View>
  );
}

/** A live "1m 4s" that ticks each second while mounted (the reference's tickTextContent). */
export function Elapsed(props: { since: () => string | number | null | undefined }) {
  const now = signal(Date.now());
  effect(() => {
    const timer = setInterval(() => now.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const text = () => {
    const since = props.since();
    const at = typeof since === "number" ? since : since ? Date.parse(since) : NaN;
    return Number.isFinite(at) ? formatDuration(Math.max(1_000, now() - at)) : "";
  };
  return text() ? <Text class="text-xs text-muted-foreground">{text()}</Text> : null;
}

/** The glass alert pinned under the header: info/alert icon, the message (expandable), actions, and a dismiss. */
export function LaneAlertCard(props: { alert: () => LaneAlert }) {
  const expanded = signal(false);
  const showFullHover = createHover();
  const alert = () => props.alert();
  const warning = () => alert().variant === "warning";
  const icon = (): BannerIconName => (alert().mark === "info" ? "info" : "circle-alert");
  return (
    <View class="mx-4 items-center pt-3" style={{ pointerEvents: "box-none" }}>
      {/* Reference: mx-auto w-fit max-w-[calc(100%-2rem)]; the card centres inside a 1rem gutter and never outgrows the lane. */}
      <View
        role="alert"
        testID={`Lane alert ${alert().id}`}
        class={`min-w-0 max-w-full flex-row items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-sm ${warning() ? "border-warning" : "border-error"}`}
        // GPUI cannot blur the content behind this floating alert. Flatten the
        // reference's 4% tint over the page color so text stays legible.
        style={{ backgroundColor: tokenOver(warning() ? "warning" : "error", "background", 0.04) }}
      >
        <View class="mt-0.5 shrink-0"><BannerIcon name={icon()} size={16} tint={token(warning() ? "warning" : "error")} /></View>
        <View class="min-w-0 shrink gap-2">
          <View class="gap-1">
            {alert().title ? <Text class={`text-sm font-medium ${warning() ? "text-warning-foreground" : "text-error-foreground"}`}>{alert().title}</Text> : null}
            {alert().message ? (
              <View selectable>
                <Text class={`text-sm ${warning() ? "text-warning-foreground" : "text-error-foreground"} ${expanded() || !alert().full ? "" : "line-clamp-3"}`}>
                  {expanded() && alert().full ? alert().full : alert().message}
                </Text>
              </View>
            ) : null}
            {alert().full ? (
              <View role="button" accessibilityLabel={expanded() ? "Show less" : "Show full error"} onPress={() => expanded.update((value) => !value)} class="self-start" {...showFullHover.bind}>
                <Text class={`text-xs font-medium text-muted-foreground ${showFullHover.hovered() ? "underline" : ""}`}>{expanded() ? "Show less" : "Show full error"}</Text>
              </View>
            ) : null}
          </View>
          {alert().actions.length > 0 ? (
            <View class="flex-row flex-wrap items-center justify-end gap-3">
              <Each of={alert().actions} key={(action) => action.id}>{(action) => <BannerActionButton action={action()} />}</Each>
            </View>
          ) : null}
        </View>
        <DismissButton label={alert().dismissLabel} onPress={alert().onDismiss} />
      </View>
    </View>
  );
}
