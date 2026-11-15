// Small shared pieces of the provider panel: icons, committing inputs, buttons, sections and rows.
import { colorScheme, computed, effect, Image, signal, Text, token, untracked, View } from "nsh";
import { Tooltip } from "nsh/base";
import { acpRegistryIconUrl } from "../../../components/providerIconResolver";
import { DialogInput as Input } from "../../../components/DialogInput";
import { ChevronTurn, toggleWithLayout } from "../../../components/motion/Motion";
import { COLLAPSE_MS } from "../../../components/motion/motionTokens";
import arrowDown from "./icons/arrow-down.svg";
import arrowUp from "./icons/arrow-up.svg";
import building from "./icons/building.svg";
import check from "./icons/check.svg";
import chevronDown from "./icons/chevron-down.svg";
import chevronRight from "./icons/chevron-right.svg";
import chevronUp from "./icons/chevron-up.svg";
import circleArrowUp from "./icons/circle-arrow-up.svg";
import copy from "./icons/copy.svg";
import download from "./icons/download.svg";
import ellipsisVertical from "./icons/ellipsis-vertical.svg";
import search from "./icons/search.svg";
import server from "./icons/server.svg";
import externalLink from "./icons/external-link.svg";
import loaderCircle from "./icons/loader-circle.svg";
import lockOpen from "./icons/lock-open.svg";
import lock from "./icons/lock.svg";
import pencil from "./icons/pencil.svg";
import plus from "./icons/plus.svg";
import refreshCw from "./icons/refresh-cw.svg";
import rotateCcw from "./icons/rotate-ccw.svg";
import star from "./icons/star.svg";
import undo2 from "./icons/undo-2.svg";
import trash2 from "./icons/trash-2.svg";
import triangleAlert from "./icons/triangle-alert.svg";
import xIcon from "./icons/x.svg";
import anthropicIcon from "../provider-icons/anthropic.svg";
import ollamaIcon from "../provider-icons/ollama.svg";
import openRouterIcon from "../provider-icons/openrouter.svg";
import codexIcon from "../provider-icons/codex.svg";
import { driverMeta, type DriverMeta } from "./driverMeta";
import { accentForeground, instanceInitials, normalizeAccentColor } from "./logic";

const ICONS = {
  "arrow-down": arrowDown, "arrow-up": arrowUp, building, check, "chevron-down": chevronDown, "chevron-right": chevronRight, "chevron-up": chevronUp,
  "circle-arrow-up": circleArrowUp, "more-vertical": ellipsisVertical, search, copy, download, "external-link": externalLink, "loader-circle": loaderCircle, "lock-open": lockOpen, lock, pencil, plus,
  "refresh-cw": refreshCw, "rotate-ccw": rotateCcw, server, star, "trash-2": trash2, "undo-2": undo2, "triangle-alert": triangleAlert, x: xIcon,
};
export type UiIconName = keyof typeof ICONS;
type Tone = "muted" | "foreground" | "warning" | "destructive" | "primary";
const TONES: Record<Tone, { light: string; dark: string }> = {
  muted: { light: "#6f6873", dark: "#969ca6" },
  foreground: { light: "#241523", dark: "#fffaff" },
  warning: { light: "#b74b00", dark: "#ffb900" },
  destructive: { light: "#c10007", dark: "#ff6467" },
  primary: { light: "#346bf1", dark: "#6b95f5" },
};

export function UiIcon(props: { name: UiIconName; size?: number; tone?: Tone; fill?: boolean }) {
  const size = () => props.size ?? 16;
  const color = () => TONES[props.tone ?? "muted"][colorScheme()];
  return <Image src={ICONS[props.name]} style={{ width: size(), height: size(), tintColor: color() }} />;
}

/** The service a text generator reaches picks its picker icon (providerInstanceIcon's PROVIDER_ICON_BY_PROVIDER). */
const BRAND_ICONS: Record<string, any> = { openai: codexIcon, anthropic: anthropicIcon, openrouter: openRouterIcon, ollama: ollamaIcon };

/** The driver's artwork in the colour its client definition names for the current theme. */
export function ProviderIconView(props: { driver: string; name: string; accentColor?: string | null; size?: number; badge?: boolean; instanceId?: string | null; fillSlot?: boolean }) {
  const meta = (): DriverMeta | undefined => driverMeta(props.driver);
  // An ACP registry agent shows its registry artwork (resolved centrally), falling back to the driver mark when it fails.
  const failedUrl = signal<string | null>(null);
  const registryUrl = () => { const url = props.instanceId ? acpRegistryIconUrl(props.instanceId) : null; return url && url !== failedUrl() ? url : null; };
  const size = () => props.size ?? 20;
  const artworkSize = () => props.fillSlot ? size() : size() - 4;
  const accent = () => normalizeAccentColor(props.accentColor);
  const tint = () => { const tintValue = meta()?.tint ?? (BRAND_ICONS[props.driver] ? { light: "#000000", dark: "#ffffff" } : null); return tintValue ? tintValue[colorScheme()] : undefined; };
  return <View class="relative items-center justify-center" style={{ width: size(), height: size() }}>
    {registryUrl()
      ? <Image src={registryUrl()!} accessibilityLabel={`${props.name} icon`} onError={() => failedUrl.set(registryUrl())} style={{ width: artworkSize(), height: artworkSize(), borderRadius: 4, objectFit: "contain" }} />
      : props.driver === "openaiCompatible"
      // ProviderInstanceIcon isCustomEndpoint: no brand, so its initials on a bordered tile marked with the OpenAI protocol;
      // below ~18pt the tile keeps one letter and drops the mark.
      ? <View class="items-center justify-center rounded-md border border-border bg-card" style={{ width: artworkSize(), height: artworkSize() }} accessibilityLabel={`${props.name} icon`}>
        <Text class="text-4xs font-semibold text-foreground">{size() < 20 ? Array.from(instanceInitials(props.name))[0] : instanceInitials(props.name)}</Text>
        {size() >= 20 ? <View class="absolute items-center justify-center rounded-full border bg-card" style={{ right: -5, bottom: -5, width: 12, height: 12, borderColor: token("card") }}>
          <Image src={BRAND_ICONS.openai} style={{ width: 8, height: 8, tintColor: colorScheme() === "dark" ? "#ffffff" : "#000000" }} />
        </View> : null}
      </View>
      : meta()?.icon ?? BRAND_ICONS[props.driver]
      ? <Image src={(meta()?.icon ?? BRAND_ICONS[props.driver]) as any} style={{ width: artworkSize(), height: artworkSize(), ...(tint() ? { tintColor: tint() } : {}) }} />
      : <Text class="text-[10px] font-semibold text-foreground">{instanceInitials(props.name)}</Text>}
    {props.badge && accent() && props.driver !== "openaiCompatible"
      ? <View class="absolute right-0 bottom-0 h-3.5 min-w-3.5 items-center justify-center rounded-full border border-card px-0.5" style={{ backgroundColor: accent() }}>
        <Text class="text-[9px] font-semibold" style={{ color: accentForeground(accent() as string) }}>{instanceInitials(props.name)}</Text>
      </View> : null}
  </View>;
}

/** An input that commits on blur or return, as the web's DraftInput does. */
export function DraftInput(props: {
  label: string; value: string; placeholder?: string; masked?: boolean; disabled?: boolean; mono?: boolean; class?: string;
  onCommit: (value: string) => void;
  /** The field took / lost the focus (a stepper's keys, components/stepperKeys.ts). */
  onFocus?: () => void; onBlur?: () => void;
}) {
  const draft = signal<string | null>(null);
  let committed: string | null = null;
  // A saved value arriving (or changing) replaces whatever was typed; until then the typed text stays visible.
  const current = computed(() => props.value);
  effect(() => { current(); untracked(() => { draft.set(null); committed = null; }); });
  const shown = () => draft() ?? props.value;
  const commit = () => {
    const next = draft();
    if (next === null || next === props.value || next === committed) return;
    committed = next;
    props.onCommit(next);
  };
  return <Input
    accessibilityLabel={props.label} testID={`input ${props.label}`} value={shown()} placeholder={props.placeholder ?? ""} masked={props.masked}
    readonly={props.disabled} autoCapitalize="none" autoCorrect={false}
    onChange={(event) => { draft.set(event.value); committed = null; }} onFocus={() => props.onFocus?.()} onBlur={() => { props.onBlur?.(); commit(); }} onSubmit={commit}
    class={`h-7.5 min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground ${props.mono ? "font-mono" : ""} ${props.disabled ? "opacity-64" : ""} ${props.class ?? "w-56"}`}
  />;
}

export type ButtonVariant = "outline" | "ghost" | "primary" | "ghost-destructive";
export function PillButton(props: {
  label: string; children?: any; onPress: () => void; variant?: ButtonVariant; disabled?: boolean; size?: "xs" | "sm"; testID?: string; tooltip?: string | any;
}) {
  const variant = () => props.variant ?? "outline";
  const cls = () => {
    const base = props.size === "xs" ? "h-6 flex-row items-center gap-1 rounded-lg px-2" : "h-7 flex-row items-center gap-1.5 rounded-lg px-3";
    const look = variant() === "outline" ? "border border-input bg-background hover:bg-accent-50"
      : variant() === "primary" ? "bg-primary hover:opacity-90"
      : variant() === "ghost-destructive" ? "hover:bg-accent-50" : "hover:bg-accent-50";
    return `${base} ${look} ${props.disabled ? "opacity-64" : ""}`;
  };
  return <View accessibilityLabel={props.label} testID={props.testID} role="button" tooltip={typeof props.tooltip === "string" ? <Tip label={props.tooltip} /> : props.tooltip} disabled={props.disabled} onPress={() => { if (!props.disabled) props.onPress(); }} class={cls()}>{props.children}</View>;
}
export function ButtonText(props: { children: any; tone?: "default" | "muted" | "primary" | "destructive" }) {
  const cls = () => props.tone === "muted" ? "text-xs text-muted-foreground" : props.tone === "primary" ? "text-sm text-primary-foreground" : props.tone === "destructive" ? "text-sm text-destructive-foreground" : "text-sm text-foreground";
  return <Text class={cls()}>{props.children}</Text>;
}
/** The web's TooltipPopup: a small popover bubble over the control while the pointer rests on it. */
export function Tip(props: { label?: string; children?: any; placement?: "top" | "bottom" }) {
  return <Tooltip placement={props.placement ?? "top"} class="max-w-80 rounded-md border border-border bg-popover px-2 py-1">
    {props.children ?? <Text class="text-xs text-popover-foreground">{props.label}</Text>}
  </Tooltip>;
}
/**
 * A control an administrator's policy turns off: shown at half opacity and inert, with the policy's
 * reason on hover. Without a reason it renders the control untouched (ManagedPolicy.tsx).
 */
export function ManagedControl(props: { reason: string | undefined; children?: any }) {
  return <View>{props.reason === undefined ? props.children : <View accessibilityLabel={props.reason} testID={`Managed control ${props.reason}`} role="group" tooltip={<Tip label={props.reason} />} class="flex-row rounded-md">
    <View class="flex-row items-center gap-2 opacity-50" style={{ pointerEvents: "none" }}>{props.children}</View>
  </View>}</View>;
}
export function IconButton(props: { label: string; icon: UiIconName; onPress: () => void; disabled?: boolean; tone?: Tone; size?: number; testID?: string; tooltip?: string }) {
  return <View accessibilityLabel={props.label} testID={props.testID} role="button" tooltip={props.tooltip ? <Tip label={props.tooltip} /> : undefined} disabled={props.disabled} onPress={() => { if (!props.disabled) props.onPress(); }}
    class={`size-6 items-center justify-center rounded-lg hover:bg-accent-50 ${props.disabled ? "opacity-64" : ""}`}><UiIcon name={props.icon} size={props.size ?? 14} tone={props.tone} /></View>;
}

/** A titled group: heading row with optional action over a rounded card of rows. */
export function Section(props: { title?: string; icon?: any; action?: any; titleAction?: any; plain?: boolean; flat?: boolean; children?: any }) {
  return <View class="gap-2.5">
    {props.title || props.action ? <View class="min-h-7 flex-row items-start justify-between gap-4 px-4">
      <View class="min-w-0 flex-row items-center gap-1">
        <View class="min-h-7 flex-row items-center gap-2">
          {props.icon ?? null}
          {props.title ? <Text class="text-base font-semibold text-foreground">{props.title}</Text> : null}
        </View>
        {props.titleAction ?? null}
      </View>
      <View class="min-h-7 min-w-7 flex-row items-center justify-end">{props.action ?? null}</View>
    </View> : null}
    {props.plain ? props.children : props.flat ? <View>{props.children}</View> : <View class="overflow-hidden rounded-xl border border-border-60 bg-card-40">{props.children}</View>}
  </View>;
}
/** FoldedSettingsSection (header outside): a quiet heading that opens a card of rows. */
export function FoldedSection(props: { title: string; children?: any }) {
  const open = signal(false);
  return <View class="gap-2.5" testID={`Folded ${props.title}`}>
    <View class="min-h-7 flex-row items-start justify-between gap-4 px-4">
      <View accessibilityLabel={`${open() ? "Collapse" : "Expand"} ${props.title}`} role="button" onPress={() => toggleWithLayout(COLLAPSE_MS, () => open.set(!open()))} class="min-h-7 flex-row items-center gap-2 rounded-md">
        <Text class="text-sm font-normal text-muted-foreground">{props.title}</Text>
        <ChevronTurn open={open}><UiIcon name="chevron-right" size={16} /></ChevronTurn>
      </View>
    </View>
    {open() ? <View class="overflow-hidden rounded-xl border border-border-60 bg-card-40">{props.children}</View> : null}
  </View>;
}
/**
 * FoldedSettingsSection (header inside): a rounded card whose header row folds the rows below it, with a
 * one-line summary beside the title and an optional control at the right.
 */
export function FoldedSettingsSection(props: { title: string; summary?: string | null; control?: any; children?: any; testID?: string }) {
  const open = signal(false);
  return <View class="overflow-hidden rounded-xl border border-border-60 bg-card-40" testID={props.testID ?? `Folded ${props.title}`}>
    <View class="flex-row flex-wrap items-center gap-x-4 px-4">
      <View accessibilityLabel={`${open() ? "Collapse" : "Expand"} ${props.title}`} accessibilityState={{ expanded: open() }} role="button" onPress={() => open.set(!open())}
        class="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-md py-2">
        <View class={open() ? "rotate-90" : ""}><UiIcon name="chevron-right" size={16} /></View>
        <Text class="shrink-0 text-sm font-medium text-foreground">{props.title}</Text>
        {props.summary ? <Text class="min-w-0 truncate text-xs text-muted-foreground">{props.summary}</Text> : null}
      </View>
      {props.control ? <View class="max-w-full flex-row items-center py-1.5">{props.control}</View> : null}
    </View>
    {open() ? <View class="border-t border-border-50">{props.children}</View> : null}
  </View>;
}
/** WizardSteps: the numbered progress strip at the top of a wizard dialog. */
export function WizardSteps(props: { steps: readonly string[]; current: number; isDisabled?: (index: number) => boolean; onChange?: (index: number) => void }) {
  return <View class="flex-row gap-1 rounded-xl border border-border-60 bg-background p-1" testID="Setup progress">
    <Each of={props.steps.map((name, index) => ({ name, index }))} key={(entry) => entry.name}>{(entry) => <View accessibilityLabel={`${entry().name}, step ${entry().index + 1}`}
      accessibilityState={{ selected: props.current === entry().index }} role="button" disabled={props.isDisabled?.(entry().index) === true} onPress={() => { if (props.isDisabled?.(entry().index) !== true) props.onChange?.(entry().index); }}
      class={`min-w-0 flex-1 flex-row items-center gap-2 rounded-lg px-2.5 py-2 ${props.current === entry().index ? "bg-card" : "hover:bg-card"}`}>
      <View class={`size-5 items-center justify-center rounded-full border ${entry().index < props.current ? "border-primary bg-primary" : props.current === entry().index ? "border-primary bg-card" : "border-border-60 bg-card"}`}>
        {entry().index < props.current ? <UiIcon name="check" size={12} tone="foreground" /> : <Text class={props.current === entry().index ? "text-xs font-medium text-primary" : "text-xs font-medium text-muted-foreground"}>{String(entry().index + 1)}</Text>}
      </View>
      <Text class={`min-w-0 text-sm font-medium truncate ${props.current === entry().index ? "text-foreground" : "text-muted-foreground"}`}>{entry().name}</Text>
    </View>}</Each>
  </View>;
}
export function Divider() { return <View class="h-px bg-border-50" />; }

/** A setting: title and description to the left, its control to the right (SettingsRow). */
export function Row(props: { title: any; description?: any; status?: any; control?: any; children?: any; divider?: boolean; testID?: string; resetAction?: any; managed?: string | undefined }) {
  return <View testID={props.testID}>
    {props.divider === false ? null : <View class="h-px bg-border-50" />}
    <View class={`px-4 ${props.children ? "pt-3 pb-1" : "py-3"}`}>
      <View class="flex-row items-center gap-8">
        <View class="min-w-0 flex-1 gap-1">
          <View class="min-h-5 flex-row items-center gap-1.5">
            {typeof props.title === "string" ? <Text class="text-sm font-medium text-foreground">{props.title}</Text> : props.title}
            <View class="size-5 items-center justify-center">{props.managed === undefined ? props.resetAction ?? null : null}</View>
          </View>
          {props.description ? (typeof props.description === "string" ? <Text class="max-w-2xl text-xs leading-normal text-muted-foreground">{props.description}</Text> : props.description) : null}
          {props.status ? <View class="flex-row flex-wrap items-center gap-1.5 pt-0.5">{props.status}</View> : null}
        </View>
        {props.managed !== undefined && props.control ? <ManagedControl reason={props.managed}>{props.control}</ManagedControl> : props.control ?? null}
      </View>
      {props.children ?? null}
    </View>
  </View>;
}

export function ErrorText(props: { children: any }) {
  return <Text role="alert" class="text-xs text-destructive-foreground">{props.children}</Text>;
}
