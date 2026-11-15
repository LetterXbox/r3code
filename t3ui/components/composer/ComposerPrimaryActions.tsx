// The composer's primary action (chat/ComposerPrimaryActions.tsx). Idle with nothing to send it is a
// disabled arrow; during a turn with an empty draft it is the size-8 Stop control; with content it
// follows the follow-up setting (Queue / Steer), the alternate modifier flips it, Resume appears
// when a run was interrupted or the queue is held, and editing a queued message turns it into a
// check that updates that message.
import { colorScheme, Image, signal, Text, token, View } from "nsh";
import { sidebarBackdropVariant } from "../../pages/settings/environmentIdentification";
import { stageButtonArtSource } from "../sidebar/stage/stageButtonArt";
import { builtThemeForMode } from "../../pages/settings/builtTheme";
import { Spinner } from "../sidebar/Spinner";
import { tokenAlpha } from "./tokenColor";
import type { Content } from "./Popover";
import { ComposerIcon } from "./ComposerIcon";

export type PrimaryKind = "stop" | "resume" | "update" | "queue" | "steer" | "submit";

export function primaryKind(input: { canInterrupt: boolean; hasSendableContent: boolean; editingQueued: boolean; canResume: boolean; mode: "auto" | "queue" | "steer" }): PrimaryKind {
  if (input.canInterrupt && !input.hasSendableContent && !input.editingQueued) return "stop";
  if (input.canResume && !input.hasSendableContent && !input.editingQueued) return "resume";
  if (input.editingQueued) return "update";
  if (input.mode === "queue") return "queue";
  if (input.mode === "steer") return "steer";
  return "submit";
}

/**
 * The primary button's colour in each state (ComposerPrimaryActions.tsx): Stop is destructive; every other kind is the
 * message-action colour while it can act and a neutral foreground/12 circle with muted text when nothing is sendable.
 */
export function primaryTone(kind: PrimaryKind, disabled: boolean): "stop" | "neutral" | "action" {
  if (kind === "stop") return "stop";
  return disabled ? "neutral" : "action";
}

/** StageBackdropButtonArt: the sidebar's stage art in the button (viewBox "64|96 0 8192 96" sliced to the button's height). */
function StageButtonArt(props: { variant: "dev" | "nightly"; size: number }) {
  const scheme = () => (colorScheme() === "dark" ? "dark" : "light");
  const art = () => stageButtonArtSource(props.variant === "nightly" ? "nightly" : "blueprint", builtThemeForMode(scheme()), scheme())
    ?? stageButtonArtSource(props.variant === "nightly" ? "nightly" : "blueprint", "ocean", scheme())!;
  return (
    <View class="absolute inset-0 overflow-hidden rounded-full" style={{ pointerEvents: "none" }}>
      <Image
        src={art()}
        style={{ width: props.size, height: props.size }}
      />
    </View>
  );
}

export function ComposerPrimaryActions(props: {
  kind: () => PrimaryKind;
  /** The accessible name and tooltip: the resolved submit label or the disabled reason. */
  label: () => string;
  tooltip: () => string;
  disabled: () => boolean;
  busy: () => boolean;
  onInterrupt: () => void;
  onResume: () => void;
  /** `alternate` is true when Command or Control is held. */
  onSubmit: (alternate: boolean) => void;
  /** The formatted token count of the history the next send compacts first ("Compact 212k"), else null. */
  compactTokens?: () => string | null;
  keepFullHistory?: () => boolean;
  onToggleKeepFullHistory?: () => void;
  canOperate?: () => boolean;
  /** Rendered ahead of the send button: the dictation control. */
  children?: Content;
}) {
  // stageBackdropVariant: where the environment is identified by its stage art, the send button wears that art with a
  // white icon (disabled: the art at 64% opacity) instead of the message-action fill.
  const stage = () => sidebarBackdropVariant();
  const tint = () => (stage() ? "#ffffff" : String(token(primaryTone(props.kind(), props.disabled()) === "neutral" ? "muted-foreground" : "message-action-foreground")));
  const stopHovered = signal(false);
  // A stale thread compacts before the message goes (chip pressed = compact, released = keep the history).
  const compactTokens = () => (props.kind() === "resume" || props.kind() === "update" || props.kind() === "stop" ? null : (props.compactTokens?.() ?? null));
  const keep = () => props.keepFullHistory?.() ?? false;
  return (
    <View class="flex-row items-center gap-2">
    {compactTokens() !== null ? (
      <View
        class={`h-7 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent ${keep() ? "" : "bg-accent-50"}`}
        tooltip={keep() ? `Next send keeps all ${compactTokens()} tokens. Click to compact first` : `Next send compacts ${compactTokens()} tokens first. Click to keep full history`}
        disabled={props.canOperate ? !props.canOperate() : false}
        onPress={() => props.onToggleKeepFullHistory?.()}
        accessibilityLabel={`Compact ${compactTokens()} tokens of history before sending`}
        role="button"
      >
        <ComposerIcon name="minimize-2" size={16} />
        <Text class="text-sm font-medium text-foreground">{keep() ? "Keep" : "Compact"}</Text>
        <Text class="text-sm text-muted-foreground">{compactTokens()}</Text>
      </View>
    ) : null}
    {props.children ?? null}
    {props.kind() === "stop" ? (
    <View
      // `bg-destructive/90 ... hover:bg-destructive`: the inline 90% fill would mask a hover class, so hover drives it.
      class="size-8 items-center justify-center rounded-full shadow-sm transition-colors duration-150 ease-in-out"
      onMouseEnter={() => stopHovered.set(true)}
      onMouseLeave={() => stopHovered.set(false)}
      style={{ backgroundColor: stopHovered() ? token("destructive") : tokenAlpha("destructive", 0.9) }}
      tooltip="Interrupt"
      disabled={props.canOperate ? !props.canOperate() : false}
      onPress={() => { if (!props.canOperate || props.canOperate()) props.onInterrupt(); }}
      accessibilityLabel="Stop generation"
      role="button"
    >
      <View class="size-2 rounded-[1.5px] bg-white" />
    </View>
  ) : (
    <View
      class={`relative size-8 items-center justify-center overflow-hidden rounded-full ${stage() ? (props.disabled() ? "opacity-64" : "shadow-sm") : primaryTone(props.kind(), props.disabled()) === "neutral" ? "" : "bg-message-action shadow-sm hover:bg-message-action-hover"} transition-all duration-150 ease-in-out ${props.disabled() ? "" : "hover:scale-105"}`}
      style={!stage() && primaryTone(props.kind(), props.disabled()) === "neutral" ? { backgroundColor: tokenAlpha("foreground", 0.12) } : undefined}
      tooltip={props.tooltip()}
      disabled={props.disabled()}
      onPress={(event) => {
        if (props.kind() === "resume") props.onResume();
        else props.onSubmit(event.modifiers.platform || event.modifiers.control);
      }}
      accessibilityLabel={props.label()}
      role="button"
    >
      {stage() ? <StageButtonArt variant={stage()!} size={32} /> : null}
      {props.busy() ? <Spinner size={14} tint={tint()} />
        : props.kind() === "resume" ? <ComposerIcon name="play" size={16} tint={tint()} />
        : props.kind() === "update" ? <ComposerIcon name="check" size={16} tint={tint()} />
        : props.kind() === "queue" ? <ComposerIcon name="list-plus" size={16} tint={tint()} />
        : props.kind() === "steer" ? <ComposerIcon name="corner-up-right" size={16} tint={tint()} />
        : <ComposerIcon name="arrow-up" size={14} tint={tint()} />}
    </View>
    )}
    </View>
  );
}
