// Small controls Settings > Voice draws that the shared settings layout has no equivalent of: a select whose
// trigger can carry an icon and whose items can be disabled, the outline Badge with a tooltip, the voice
// pill (VoiceInputPill) and the dictionary editor (DictionaryEditor in VoiceSettingsPanel.tsx).
import { effect, keymap, Scroll, signal, Text, token, View } from "nsh";
import { Select } from "nsh/base";
import { DialogInput as Input, DialogInput } from "../../../components/DialogInput";
import { Icon } from "../../../components/Icons";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { PillButton, Tip } from "../providers/ui";
import { addAlias, addTerms, canAddTerms, newTermsOf, type SpeechCustomWords } from "./speech";
import { VoiceIcon, type VoiceIconName, type VoiceIconTone } from "./VoiceIcon";

export interface VoiceSelectItem { value: string; title: string; group?: string | null; disabled?: boolean; icon?: VoiceIconName }

/** The web's Select (`SelectTrigger size="sm"`, popup `align="end"`), registered with the WebView occlusion registry while open. */
export function VoiceSelect(props: {
  label: string;
  value: string;
  items: VoiceSelectItem[];
  /** The closed trigger's text when it differs from the chosen item's title. */
  triggerText?: string;
  triggerIcon?: VoiceIconName | null;
  /** Muted text after the trigger text (" via Environment"). */
  triggerSuffix?: string | null;
  disabled?: boolean;
  maxWidth?: number;
  /** A search field over the items, with this placeholder (the OpenRouter model combobox). */
  searchPlaceholder?: string;
  /** Inline only: the text when the search matches nothing (ComboboxEmpty). */
  searchEmpty?: string;
  onChange: (next: string) => void;
  /** Inside a Dialog: the list (and its search) opens in the dialog's own tree; a popup from a Dialog does not take
   * presses on the GPUI host (workspace/nsh-runtime-bugs.md #8). */
  inline?: boolean;
}) {
  if (props.inline) return <InlineVoiceSelect {...props} />;
  const open = signal(false);
  useOverlayOpen(() => open(), "voice select");
  const chosen = () => props.items.find((item) => item.value === props.value);
  const text = () => props.triggerText ?? chosen()?.title ?? props.value;
  const hasIcons = () => props.items.some((item) => item.icon);
  return (
    <Select
      open={open()}
      onOpenChange={(e: { open: boolean }) => open.set(e.open)}
      value={props.value}
      disabled={props.disabled}
      align="end"
      searchable={props.searchPlaceholder !== undefined}
      searchPlaceholder={props.searchPlaceholder ?? null}
      searchAccessibilityLabel={props.searchPlaceholder ?? null}
      items={props.items.map((item) => ({ value: item.value, title: item.title, group: item.group ?? null, disabled: item.disabled === true }))}
      renderItem={hasIcons() ? (entry: { value: string; title: string }) => {
        const icon = props.items.find((item) => item.value === entry.value)?.icon;
        return (
          <View class="flex-row items-center gap-2">
            {icon ? <VoiceIcon name={icon} size={16} /> : null}
            <Text class="text-sm text-popover-foreground">{entry.title}</Text>
          </View>
        );
      } : undefined}
      groupClass="px-2 py-1.5 text-xs font-medium text-muted-foreground"
      onChange={(e: { value: string | null }) => { if (e.value !== null) props.onChange(e.value); }}
      trigger={
        <View
          class={`h-7 min-w-0 flex-row items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-[9px] dark:bg-input-32 ${props.disabled ? "opacity-64" : ""}`}
          style={{ maxWidth: props.maxWidth ?? 288 }}
          testID={`${props.label} = ${props.value}`}
          accessibilityLabel={props.label}
        >
          {props.triggerIcon ? <VoiceIcon name={props.triggerIcon} size={16} /> : null}
          <Text class="min-w-0 shrink text-sm text-foreground">{text()}</Text>
          {props.triggerSuffix ? <Text class="min-w-0 shrink text-sm text-muted-foreground">{props.triggerSuffix}</Text> : null}
          <View class="-mr-1 opacity-70"><Icon name="chevron-down" size={14} tint={token("icon-muted")} /></View>
        </View>
      }
      itemClass="min-h-7 flex-row items-center rounded-sm px-2 py-1 text-sm text-popover-foreground selected:bg-accent-50 focus:bg-accent hover:bg-accent disabled:opacity-64"
      popupClass="min-w-56 rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
    />
  );
}

function InlineVoiceSelect(props: Parameters<typeof VoiceSelect>[0]) {
  const open = signal(false);
  const query = signal("");
  const chosen = () => props.items.find((item) => item.value === props.value);
  const text = () => props.triggerText ?? chosen()?.title ?? props.value;
  const shown = () => { const q = query().trim().toLowerCase(); return q ? props.items.filter((item) => item.title.toLowerCase().includes(q)) : props.items; };
  return (
    <View class="gap-1">
      <View role="button" disabled={props.disabled} onPress={() => { query.set(""); open.set(!open()); }}
        class={`h-7 min-w-0 flex-row items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-[9px] dark:bg-input-32 ${props.disabled ? "opacity-64" : ""}`}
        style={{ maxWidth: props.maxWidth ?? 288 }} testID={`${props.label} = ${props.value}`} accessibilityLabel={props.label}>
        {props.triggerIcon ? <VoiceIcon name={props.triggerIcon} size={16} /> : null}
        <Text class="min-w-0 shrink text-sm text-foreground">{text()}</Text>
        {props.triggerSuffix ? <Text class="min-w-0 shrink text-sm text-muted-foreground">{props.triggerSuffix}</Text> : null}
        <View class="-mr-1 opacity-70"><Icon name="chevron-down" size={14} tint={token("icon-muted")} /></View>
      </View>
      {open() ? (
        <View class="rounded-lg border border-border bg-popover p-1" style={{ maxWidth: props.maxWidth ?? 288 }}>
          {props.searchPlaceholder !== undefined ? (
            <DialogInput value={query()} placeholder={props.searchPlaceholder} accessibilityLabel={props.searchPlaceholder} onChange={(e: { value: string }) => query.set(e.value)}
              class="mb-1 h-7 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground" />
          ) : null}
          {props.searchEmpty && shown().length === 0 ? <Text class="px-2 py-1.5 text-sm text-muted-foreground">{props.searchEmpty}</Text> : null}
          <Scroll class="max-h-64">
            <Each of={shown()} key={(item) => item.value}>
              {(item) => (
                <View role="button" accessibilityLabel={item().title} disabled={item().disabled === true}
                  onPress={() => { open.set(false); props.onChange(item().value); }}
                  class={`min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent ${item().value === props.value ? "bg-accent-50" : ""} ${item().disabled ? "opacity-64" : ""}`}>
                  {item().icon ? <VoiceIcon name={item().icon!} size={16} /> : null}
                  <Text class="text-sm text-popover-foreground">{item().title}</Text>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      ) : null}
    </View>
  );
}

/** Badge variant="outline" with an icon and a tooltip. */
export function ModelBadge(props: { icon: VoiceIconName; label: string; tooltip: string }) {
  return (
    <View tooltip={<Tip label={props.tooltip} />} accessibilityLabel={props.label} class="h-5 flex-row items-center rounded-sm border border-input bg-background px-1.5">
      <View class="mr-1"><VoiceIcon name={props.icon} size={12} /></View>
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
    </View>
  );
}

/** VoiceInputPill: the 256pt strip the recording controls sit in. */
export function VoicePill(props: { children: any }) {
  return <View class="h-7 w-64 min-w-0 shrink-0 flex-row items-center gap-2">{props.children}</View>;
}

/** A round icon button (`Button size="icon-sm-pill"`). */
export function PillIconButton(props: { label: string; icon: VoiceIconName; onPress: () => void; disabled?: boolean; primary?: boolean; tone?: VoiceIconTone }) {
  return (
    <View
      accessibilityLabel={props.label} role="button" disabled={props.disabled} testID={props.label}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class={`size-6 shrink-0 items-center justify-center rounded-full ${props.primary ? "bg-primary" : "hover:bg-accent-50"} ${props.disabled ? "opacity-64" : ""}`}
    >
      <VoiceIcon name={props.icon} size={14} tone={props.primary ? "primary-foreground" : props.tone} />
    </View>
  );
}

/** Add words or phrases, then the entries as chips with an alias field and a remove button. */
export function DictionaryEditor(props: { label: string; words: () => SpeechCustomWords; disabled?: boolean; onChange: (words: SpeechCustomWords) => void }) {
  const draft = signal("");
  const aliasFor = signal<{ term: string; value: string } | null>(null);
  const addable = () => !props.disabled && canAddTerms(props.words(), newTermsOf(props.words(), draft()));
  const add = () => {
    if (!addable()) return;
    const next = addTerms(props.words(), draft());
    if (!next) return;
    props.onChange(next);
    draft.set("");
  };
  // The alias field cancels on Escape (the reference's onKeyDown); Settings binds Escape itself, so while an alias is being typed
  // this newer binding takes it first, as SettingsDialog does.
  effect(() => {
    if (aliasFor() === null) return;
    return keymap.bind({ escape: () => aliasFor.set(null) }, { when: "always" });
  });
  const commitAlias = () => {
    const pending = aliasFor();
    if (!pending) return;
    const next = addAlias(props.words(), pending.term, pending.value);
    if (next) { props.onChange(next); aliasFor.set(null); }
  };
  return (
    <View class="gap-3">
      <View class="flex-row items-start gap-1.5">
        <Input
          multiline
          submitBehavior="submit"
          value={draft()}
          maxLength={5100}
          readonly={props.disabled}
          placeholder="Add words or phrases, separated by commas or line breaks"
          accessibilityLabel={`Add a word or phrase to the ${props.label}`}
          onChange={(e: { value: string }) => draft.set(e.value)}
          onSubmit={add}
          class="min-h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground"
        />
        <PillButton label="Add" disabled={!addable()} onPress={add} variant="outline"><Text class="text-sm text-foreground">Add</Text></PillButton>
      </View>
      {props.words().length > 0 ? (
        <View class="flex-row flex-wrap gap-1.5" accessibilityLabel={`${props.label} entries`}>
          <Each of={props.words()} key={(entry) => entry.term}>
            {(entry) => (
              <View class="flex-row items-center gap-1 rounded-md border border-border-60 bg-muted-30 py-0.5 pr-0.5 pl-2">
                <Text class="text-xs font-medium text-foreground">{entry().term}</Text>
                {entry().aliases.length > 0 ? <Text class="text-xs text-muted-foreground">{`← ${entry().aliases.join(", ")}`}</Text> : null}
                {aliasFor()?.term === entry().term ? (
                  <Input
                    autoFocus value={aliasFor()?.value ?? ""} maxLength={50} placeholder="Misspelling"
                    accessibilityLabel={`Alias for ${entry().term}`}
                    onChange={(e: { value: string }) => aliasFor.set({ term: entry().term, value: e.value })}
                    onSubmit={commitAlias}
                    onBlur={() => aliasFor.set(null)}
                    class="h-6 w-32 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                  />
                ) : (
                  <View
                    accessibilityLabel={`Add an alias for ${entry().term}`} role="button" disabled={props.disabled || entry().aliases.length >= 8}
                    onPress={() => aliasFor.set({ term: entry().term, value: "" })}
                    class="h-6 items-center justify-center rounded-md px-1.5 hover:bg-accent-50"
                  >
                    <Text class="text-xs text-muted-foreground">Alias</Text>
                  </View>
                )}
                <View
                  accessibilityLabel={`Remove ${entry().term}`} role="button" disabled={props.disabled}
                  onPress={() => props.onChange(props.words().filter((word) => word.term !== entry().term))}
                  class="size-6 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"
                >
                  <VoiceIcon name="x" size={12} tone="muted-foreground" />
                </View>
              </View>
            )}
          </Each>
        </View>
      ) : null}
    </View>
  );
}

/** A multi-line field (`Textarea`): read-only while the built-in text shows. */
export function TextArea(props: { label: string; value: string; readonly?: boolean; onChange: (value: string) => void }) {
  return (
    <Input
      multiline value={props.value} readonly={props.readonly} maxLength={10_000} accessibilityLabel={props.label} testID={`${props.label} (${props.readonly ? "readonly" : "editable"})`}
      onChange={(e: { value: string }) => { if (!props.readonly) props.onChange(e.value); }}
      class={`min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground ${props.readonly ? "opacity-64" : ""}`}
    />
  );
}

/** A small ghost icon button (`Button size="icon-sm" variant="ghost"`), with an optional tooltip. */
export function VoiceIconButton(props: { label: string; icon: VoiceIconName; onPress: () => void; tooltip?: string; disabled?: boolean }) {
  return (
    <View
      accessibilityLabel={props.label} role="button" disabled={props.disabled} testID={props.label} tooltip={props.tooltip ? <Tip label={props.tooltip} /> : undefined}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class={`size-7 items-center justify-center rounded-lg hover:bg-accent-50 ${props.disabled ? "opacity-64" : ""}`}
    >
      <VoiceIcon name={props.icon} size={14} />
    </View>
  );
}
