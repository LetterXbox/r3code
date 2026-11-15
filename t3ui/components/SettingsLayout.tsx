// The settings panels' shared shapes, ported from
// components/settings/settingsLayout.tsx, SettingsGroup.tsx and the web's
// WorkspacePageContainer.
//
// Every settings panel is a stack of titled sections, each a rounded card of
// rows. Porting these shapes once is what makes the other panels a matter of
// listing rows, exactly as they are on the web.
import { effect, signal, Text, token, View } from "nsh";
import { Icon } from "./Icons";
import { ComposerIcon } from "./composer/ComposerIcon";
import { Input, Menu, MenuItem, Slider, Switch } from "nsh/base";
import { SettingsIcon } from "../pages/settings/SettingsIcon";
import { trackOpenChange, useOverlayOpen } from "./rightPanel/nativeOcclusion";
import { tokenAlpha } from "./composer/tokenColor";
import { codeTextStyle } from "../typography";
import { createHover } from "./hoverReveal";

/** The width the web app gives a readable settings page: `max-w-4xl`. */
export const READABLE_WIDTH = 896;

/** The scrolling column a panel sits in (WorkspacePageContainer + gap-8). */
export function SettingsPageContainer(props: { children: any }) {
  return (
    <View class="items-center">
      <View class="w-full max-w-[896px] flex-col gap-8 px-6 pt-6 pb-12">
        {props.children}
      </View>
    </View>
  );
}

/** A titled group: a heading over a rounded card of rows (SettingsSection). */
export function SettingsSection(props: {
  title: string;
  children: any;
  icon?: any;
  titleAction?: any;
  headerAction?: any;
  /** The web's `hideTitle`: the card without its heading (the Project card of Projects). */
  hideTitle?: boolean;
  /** The web's `variant="plain"`: the heading and its content without the card (a section of cards). */
  plain?: boolean;
}) {
  return (
    <View class="gap-2.5" accessibilityLabel={`${props.title} section`}>
      {props.hideTitle ? null : <View class="min-h-7 flex-row items-start justify-between gap-4 px-4">
        <View class="min-w-0 flex-row items-center gap-1">
          <View class="min-h-7 flex-row items-center gap-2">
            {props.icon ?? null}
            <Text class="text-base font-semibold text-foreground">{props.title}</Text>
          </View>
          {props.titleAction ?? null}
        </View>
        <View class="min-h-7 min-w-7 flex-row items-center justify-end">{props.headerAction ?? null}</View>
      </View>}
      {props.plain ? props.children : (
      <View class="rounded-xl border border-border-60 bg-card-40">
        {props.children}
      </View>)}
    </View>
  );
}

/** The reset-to-default undo mark beside a row's title (SettingResetButton). */
export function SettingResetButton(props: { label: string; onPress: () => void; /** The hover tip; the web's default is "Reset to default". */ tooltip?: string }) {
  return (
    <View
      class="size-5 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
      accessibilityLabel={`Reset ${props.label} to default`}
      tooltip={props.tooltip ?? "Reset to default"}
      onPress={props.onPress}
    >
      <SettingsIcon name="undo-2" size={12} />
    </View>
  );
}

/** One setting: a title and description, with its control on the right. */
export function SettingsRow(props: {
  title: string;
  /** Replaces the title text with an element (the About page's "Version" and its copyable number). */
  titleNode?: any;
  description?: string;
  /** A medium-weight span after the description (the web's InlineButton version label in the Devices rows). */
  descriptionTail?: string;
  /** An element after the description (DeviceToolVersions' popover trigger), on the description's line. */
  descriptionAction?: any;
  control?: any;
  children?: any;
  /** Shown beside the title when the value differs from its default. */
  resetAction?: any;
  /** Small status line under the description (the web's `status`). */
  status?: any;
  /** The layers mark of a scoped row (SettingInheritance), drawn between the title and the reset mark. A function
   * receives the row's hover state (the web's `group-hover/settings-row`, which a plain View cannot do here). */
  inheritance?: any;
}) {
  const hover = createHover();
  return (
    <View {...hover.bind} class="flex-row items-center gap-8 px-4 py-3">
      <View class="min-w-0 flex-1 gap-1">
        <View class="min-h-5 flex-row items-center gap-1.5">
          {props.titleNode ?? <Text class="text-sm font-medium text-foreground">{props.title}</Text>}
          {typeof props.inheritance === "function" ? props.inheritance(hover.hovered) : (props.inheritance ?? null)}
          <View class="size-5 items-center justify-center">{props.resetAction ?? null}</View>
        </View>
        {props.description && props.descriptionAction ? (
          <View class="max-w-[672px] flex-row flex-wrap items-center gap-1">
            <Text class="text-xs leading-normal text-muted-foreground">{props.description}</Text>
            {props.descriptionAction}
          </View>
        ) : props.description ? (
          <Text class="max-w-[672px] text-xs leading-normal text-muted-foreground">
            {props.description}
            {props.descriptionTail ? <Text class="font-medium">{props.descriptionTail}</Text> : null}
          </Text>
        ) : null}
        {props.status ? <View class="pt-0.5">{props.status}</View> : null}
      </View>
      {props.control ?? props.children}
    </View>
  );
}

/** The hairline between rows (`[&>*+*]:border-t border-border/50`). */
export function SettingsDivider() {
  return <View class="h-px bg-border-50" />;
}

/** A labelled on/off switch, which the panel owns the value of. */
export function SettingsSwitch(props: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Switch
      checked={props.checked}
      onChange={(e: { checked?: boolean; value?: boolean }) =>
        props.onChange(Boolean(e?.checked ?? e?.value))
      }
      accessibilityLabel={props.label}
      // The track draws no text, so its on/off state is only readable by a
      // test through an id that names it.
      testID={`${props.label} (${props.checked ? "on" : "off"})`}
      // A Switch draws no width of its own, so the track sizes it: without
      // one it is zero-sized and silently takes no presses.
      // ui/switch.tsx at its `sm:` size: thumb 16 -> a (16+2) x (16*2-2) = 18 x 30 track,
      // 2pt inset, a 14pt thumb that travels thumb-4 = 12pt; bg-primary when on, bg-input
      // when off, and in dark an off thumb is muted-foreground.
      class="h-[18px] w-[30px] items-center"
      trackClass="h-[18px] w-[30px] justify-center rounded-full p-[2px] bg-input checked:bg-primary transition-colors duration-200 ease-in-out"
      thumbClass="size-3.5 rounded-full bg-background dark:bg-muted-foreground checked:bg-background dark:checked:bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out"
    />
  );
}

/**
 * A labelled choice, the web's `Select`: a bordered `min-w-40` trigger with a
 * chevron, and a popup of `SelectItem`s. The popup is a Select overlay, so it
 * paints above the settings card and the page scroll.
 */
export function SettingsSelect(props: {
  label: string;
  value: string;
  options: { value: string; label: string | null; /** A section header over adjacent options with the same group. */ group?: string | null; /** Muted text at the end of the row (the viewport presets' sizes). */ detail?: string | null; /** A muted line under the label (the permissions select). */ description?: string | null; /** A ComposerIcon name drawn before the label (the permissions select). */ icon?: string | null; /** It cannot be chosen (a managed policy denies it): the description is replaced by this reason. */ disabled?: boolean }[];
  onChange: (next: string) => void;
  /** The web's `<SelectTrigger size="sm" className="w-full sm:w-N">`: a 28pt trigger of that fixed width. */
  compactWidth?: number;
  /** A ComposerIcon name before the closed trigger's text (the permissions select). */
  triggerIcon?: string | null;
  /** Replaces the closed trigger's text (a value whose popup label is longer than its summary). */
  triggerLabel?: string;
  /** Drawn before `triggerIcon`/the text (the diff colors select's two dots: SettingsPanels.tsx). */
  leading?: () => any;
  /** Inside a Dialog: the list opens in the dialog's own tree under the trigger instead of as a Menu popup. On the GPUI
   * host a Menu popup opened from a Dialog painted above it, but pointer presses on its items did nothing, and one
   * below the card closed the dialog through its backdrop (workspace/nsh-runtime-bugs.md #8). */
  inline?: boolean;
  /** Inline only: a search field over the options (the web's ComboboxSearchInput and ComboboxEmpty). */
  search?: { label: string; placeholder: string; empty: string };
}) {
  if (props.inline) return <InlineSettingsSelect {...props} />;
  const chosen = () => props.options.find((o) => o.value === props.value);
  // The web never shows "(default)" in a closed trigger (AppearanceSettingsPanel.tsx's "Comfortable" /
  // "Word", SettingsPanels.tsx's "Red & green"): only the popup item's own label carries it.
  const triggerText = () => {
    if (props.triggerLabel !== undefined) return props.triggerLabel;
    const label = chosen()?.label ?? props.value;
    return label.replace(/ \(default\)$/, "");
  };
  const compact = props.compactWidth !== undefined;
  const hasDescriptions = props.options.some((o) => o.description);
  const hasDetails = props.options.some((o) => o.detail);
  // The popup is drawn above a native WebView, so it registers with the occlusion registry while open.
  const open = signal(false);
  useOverlayOpen(() => open(), "settings select");
  let lastGroup: string | null | undefined;
  return (
    <Menu
      open={open()}
      onOpenChange={trackOpenChange(open)}
      // Every settings select opens `align="end"` (SettingsPanels.tsx), the popup's right edge on the trigger's.
      align="end"
      // SelectPopup: `dropdown-glass rounded-lg` over a `p-1` list with a deep shadow. `w-max` (as every
      // other anchored menu in this app does, menuStyles.ts's `MENU_POPUP_CLASS`) keeps it at least as wide
      // as its widest item: a plain `Select` here measured its popup to the trigger's width regardless of
      // any width class on it, so a long item (e.g. "⌘ + Enter for multiline prompts") was visually clipped
      // even though its full text was present in the accessibility tree -- this is why the select here is
      // a `Menu` (radio items) rather than `nsh/base`'s `Select`.
      popupClass="min-w-40 w-max rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
      // A Menu draws no trigger of its own: the app supplies the element the
      // list is placed against and pressed. Without one there is nothing to
      // press, so the row is unreachable by pointer and by test.
      trigger={
        // ui/select.tsx at `size="sm"`, which every settings select uses: `border rounded-lg text-sm
        // bg-background dark:bg-input/32 border-input`, min-h-7, gap-1.5, px 9 (+ border). The row gives
        // every select trigger `min-w-40`; most also fix a width (`sm:w-40`, `sm:w-56`).
        <View
          class="h-7 min-w-40 flex-row items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-[9px] dark:bg-input-32"
          style={compact ? { width: props.compactWidth } : undefined}
          testID={`${props.label} = ${props.value}`}
          accessibilityLabel={`${props.label} = ${props.value}`}
        >
          {props.leading ? props.leading() : null}
          {props.triggerIcon ? <ComposerIcon name={props.triggerIcon} size={14} tint={token("muted-foreground")} /> : null}
          <Text class="min-w-0 flex-1 text-sm text-foreground">{triggerText()}</Text>
          {/* `-me-1 size-3.5 opacity-70`, text-icon-muted */}
          <View class="-mr-1 opacity-70">
            <Icon name="chevron-down" size={14} tint={token("icon-muted")} />
          </View>
        </View>
      }
    >
      {props.options.map((option) => {
        const header = option.group !== lastGroup && option.group
          ? <Text class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{option.group}</Text>
          : null;
        lastGroup = option.group ?? lastGroup;
        return (
          <>
            {header}
            <MenuItem
              accessibilityLabel={option.label ?? option.value}
              role="menuitemradio"
              checked={props.value === option.value}
              disabled={option.disabled}
              // SelectItem: `min-h-7 rounded-sm px-2 py-1 text-sm`, highlighted bg-accent, chosen bg-foreground/8
              // (drawn with the accent tint: the theme has no flattened foreground-8). The web draws no check mark.
              class="min-h-7 flex-row items-center rounded-sm px-2 py-1 text-sm text-popover-foreground checked:bg-accent-50 hover:bg-accent"
              onSelect={() => props.onChange(option.value)}
            >
              {hasDescriptions ? (
                <View class="min-w-64 gap-0.5">
                  <View class="flex-row items-center gap-1.5">
                    {option.icon ? <ComposerIcon name={option.icon} size={14} tint={token("muted-foreground")} /> : null}
                    <Text class="text-sm font-medium text-popover-foreground">{option.label ?? option.value}</Text>
                  </View>
                  <Text class="text-xs leading-4 text-muted-foreground">{option.description ?? ""}</Text>
                </View>
              ) : hasDetails ? (
                <View class="w-full flex-row items-center justify-between gap-5">
                  <Text class="text-sm text-popover-foreground">{option.label ?? option.value}</Text>
                  <Text class="text-xs text-muted-foreground">{option.detail ?? ""}</Text>
                </View>
              ) : (
                <Text class="text-sm text-popover-foreground">{option.label ?? option.value}</Text>
              )}
            </MenuItem>
          </>
        );
      })}
    </Menu>
  );
}

type SettingsSelectProps = Parameters<typeof SettingsSelect>[0];

/** SettingsSelect's list laid out under its trigger, in the caller's tree (see `inline`). */
function InlineSettingsSelect(props: SettingsSelectProps) {
  const open = signal(false);
  const query = signal("");
  const shown = () => { const text = query().trim().toLowerCase(); return text ? props.options.filter((option) => (option.label ?? option.value).toLowerCase().includes(text)) : props.options; };
  const chosen = () => props.options.find((o) => o.value === props.value);
  const triggerText = () => (props.triggerLabel !== undefined ? props.triggerLabel : (chosen()?.label ?? props.value).replace(/ \(default\)$/, ""));
  return (
    <View class="gap-1">
      <View
        role="button"
        class="h-7 min-w-40 flex-row items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-[9px] dark:bg-input-32"
        style={props.compactWidth !== undefined ? { width: props.compactWidth } : undefined}
        testID={`${props.label} = ${props.value}`}
        accessibilityLabel={`${props.label} = ${props.value}`}
        onPress={() => { query.set(""); open.set(!open()); }}
      >
        {props.leading ? props.leading() : null}
        {props.triggerIcon ? <ComposerIcon name={props.triggerIcon} size={14} tint={token("muted-foreground")} /> : null}
        <Text class="min-w-0 flex-1 text-sm text-foreground">{triggerText()}</Text>
        <View class="-mr-1 opacity-70"><Icon name="chevron-down" size={14} tint={token("icon-muted")} /></View>
      </View>
      {open() ? (
        <View class="rounded-lg border border-border bg-popover p-1" accessibilityLabel={`${props.label} options`}>
          {props.search ? <Input value={query()} accessibilityLabel={props.search.label} placeholder={props.search.placeholder} onChange={(e: { value: string }) => query.set(e.value)} class="mb-1 h-7 rounded-md border border-input bg-background px-2 text-sm text-foreground" /> : null}
          {props.search && shown().length === 0 ? <Text class="px-2 py-1.5 text-sm text-muted-foreground">{props.search.empty}</Text> : null}
          {shown().map((option) => (
            <View
              role="button"
              accessibilityLabel={option.label ?? option.value}
              disabled={option.disabled}
              class={`min-h-7 flex-row items-center rounded-sm px-2 py-1 hover:bg-accent ${props.value === option.value ? "bg-accent-50" : ""}`}
              onPress={() => { open.set(false); props.onChange(option.value); }}
            >
              {option.description ? (
                <View class="min-w-0 flex-1 gap-0.5">
                  <Text class="text-sm font-medium text-popover-foreground">{option.label ?? option.value}</Text>
                  <Text class="text-xs leading-4 text-muted-foreground">{option.description}</Text>
                </View>
              ) : <Text class="text-sm text-popover-foreground">{option.label ?? option.value}</Text>}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A text field in a settings row. The draft is local; it commits on Enter or
 * after the user pauses, so a server-scoped setting is not patched per key.
 */
export function SettingsText(props: {
  label: string;
  value: string;
  placeholder?: string | null;
  /** The field's width class (the web's DraftInput className; most rows are sm:w-64). */
  widthClass?: string;
  onChange: (next: string) => void;
}) {
  const draft = signal(props.value);
  let committed = props.value;
  let timer: number | null = null;
  effect(() => {
    // The stored value moved (a reset, a server update): show it, unless the
    // user is mid-edit on something else.
    const next = props.value;
    if (next !== committed) {
      committed = next;
      draft.set(next);
    }
  });
  const commit = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = draft();
    if (next === committed) return;
    committed = next;
    props.onChange(next);
  };
  return (
    <Input
      value={draft()}
      placeholder={props.placeholder ?? ""}
      onChange={(e: { value: string }) => {
        draft.set(e.value);
        if (timer) clearTimeout(timer);
        timer = setTimeout(commit, 600);
      }}
      onSubmit={commit}
      accessibilityLabel={props.label}
      testID={`${props.label} = ${props.value}`}
      // Input size="sm": sm:h-6.5 inside a 1px border (28pt), px-[calc(--spacing(2.5)-1px)].
      class={`h-7 ${props.widthClass ?? "w-64"} rounded-lg border border-input bg-background px-[9px] text-sm text-foreground`}
    />
  );
}

/**
 * A slider row control, `flex w-full items-center gap-3 sm:w-52` in AppearanceSettingsPanel.tsx: a value chip
 * (`min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium`) LEFT of the
 * `settings-slider` (index.css): a 6pt track whose filled part is --primary over muted-foreground at 22%,
 * and a 16pt thumb with a 2pt primary ring.
 */
export function SettingsSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (next: number) => void;
}) {
  const preview = signal<number | null>(null);
  const shown = () => preview() ?? props.value;
  return (
    <View class="w-52 flex-row items-center gap-3" testID={`${props.label} = ${shown()}`}>
      <View class="min-w-12 items-center rounded-md bg-muted px-2 py-1">
        <Text class="text-xs font-medium text-foreground" style={{ fontFamily: codeTextStyle().fontFamily }}>{`${shown()}${props.unit ?? ""}`}</Text>
      </View>
      <Slider
        value={shown()}
        min={props.min}
        max={props.max}
        step={props.step}
        accessibilityLabel={props.label}
        onChange={(e: { value: number | [number, number] }) => preview.set(Array.isArray(e.value) ? e.value[0] : e.value)}
        onChangeEnd={(e: { value: number | [number, number] }) => { props.onChange(Array.isArray(e.value) ? e.value[0] : e.value); preview.set(null); }}
        class="h-6 min-w-0 flex-1"
        trackClass="h-6 justify-center"
        indicatorClass="h-1.5 w-full rounded-full border border-border-50"
        indicatorStyle={{ backgroundColor: tokenAlpha("muted-foreground", 0.22) }}
        rangeClass="rounded-full bg-primary"
        thumbClass="size-4 rounded-full border-2 border-primary bg-background transition-transform duration-120 group-hover:scale-[1.08]"
        thumbStyle={{ transitionTimingFunction: "ease" }}
      />
    </View>
  );
}

/** A small bordered button, the web's `Button variant="outline" size="xs"`. */
export function SettingsButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "default" | "destructive" | "primary" | "ghost";
  accessibilityLabel?: string;
}) {
  const tone = props.tone ?? "default";
  // Button variant default: `[:hover,[data-pressed]]:bg-primary/90`; the theme has no flattened primary-90.
  const hover = createHover();
  return (
    <View
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      {...(tone === "primary" ? hover.bind : {})}
      style={tone === "primary" && hover.hovered() && !props.disabled ? { backgroundColor: tokenAlpha("primary", 0.9) } : undefined}
      class={
        tone === "primary"
          ? "h-7 items-center justify-center rounded-lg bg-primary px-2.5 active:scale-[0.97] transition-transform duration-150 ease-in-out"
          : tone === "ghost"
          ? "h-7 items-center justify-center rounded-lg px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
          : "h-7 items-center justify-center rounded-lg border border-input bg-background px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
      }
    >
      <Text
        class={
          tone === "primary"
            ? "text-xs font-medium text-primary-foreground"
            : tone === "destructive"
              ? "text-xs font-medium text-destructive-foreground"
              : "text-xs font-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </View>
  );
}

/** The inline message a failed write leaves under a card (text-destructive). */
export function SettingsError(props: { message: () => string }) {
  // Read inside the JSX: a component body runs once, so a hoisted read would
  // freeze at its first value.
  return (
    <View class="px-4">
      {props.message() ? <Text class="text-xs text-destructive-foreground">{props.message()}</Text> : null}
    </View>
  );
}
