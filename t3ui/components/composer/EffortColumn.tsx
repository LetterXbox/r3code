// The model picker's effort column (ComposerEffortColumn in chat/ComposerModelEffort.tsx): the
// selected model's reasoning levels under the header that names them, then every other option the
// provider reports (context window, agent mode, ...) as one row each. All from the model's real
// `capabilities.optionDescriptors`; a model with none shows the web's "No effort levels" row.
import { overGlass, tokenAlpha, tokenTint } from "./tokenColor";
import { signal, Scroll, Text, token, View } from "nsh";
import type { ViewRef } from "nsh";
import { ComposerIcon } from "./ComposerIcon";
import { columnControls, currentValue, selectableChoices, traitsView } from "./modelTraits";
import type { ColumnControl, Descriptor, SelectDescriptor } from "./modelTraits";

const ROW = "h-8 w-full flex-row items-center gap-2 rounded-sm px-2";

/** What the popup asks of the column's keyboard (ComposerModelEffort.tsx moveBetweenRows, OptionMenuRow, focusEffort). */
export interface EffortBridge {
  /** Focuses the selected level, else the first one; "any" falls back to the column's first row. False when nothing took focus. */
  focus(rows: "levels" | "any"): boolean;
  /** Up or Down: the previous or next row, stopping at the ends. */
  step(direction: 1 | -1): void;
  /** Right on an option row opens its choices. */
  right(): void;
  /** Left closes the open option the focus is in and returns true; false: nothing to close, the picker returns to search. */
  left(): boolean;
}

/** The keyboard hooks a row takes from its column: a ref to register and a focus report. */
interface RowKeys { id: string; register: (id: string, node: ViewRef | null) => void; onFocus: (id: string) => void }

function LevelRow(props: { label: string; selected: boolean; isDefault?: boolean; onPick: () => void; description?: string; keys?: RowKeys }) {
  // The reference has no fill for the selected level: a check marks it, and only hover fills a row.
  const hovered = signal(false);
  return (
    <View
      class={props.description ? ROW.replace("h-8", "min-h-8 py-1") : ROW}
      style={hovered() ? { backgroundColor: tokenAlpha("foreground", 0.09) } : undefined}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onPress={props.onPick}
      ref={props.keys ? (node: ViewRef | null) => props.keys!.register(props.keys!.id, node) : undefined}
      onFocus={props.keys ? () => props.keys!.onFocus(props.keys!.id) : undefined}
      accessibilityLabel={props.label}
      accessibilityHint={props.description}
      role="radio"
    >
      {/* TraitsPicker: an option's description sits under its label (text-xs, muted, at most 14rem wide). */}
      {props.description ? (
        <View class="min-w-0 flex-1">
          <Text class="min-w-0 truncate text-sm text-foreground">{props.label}</Text>
          <Text class="text-xs text-muted-foreground" style={{ maxWidth: 224 }}>{props.description}</Text>
        </View>
      ) : <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{props.label}</Text>}
      {props.selected ? <ComposerIcon name="check" size={14} tint={tokenTint("foreground")} /> : props.isDefault ? <Text class="text-xs text-muted-foreground">Default</Text> : null}
    </View>
  );
}

function SelectRow(props: { descriptor: SelectDescriptor; onChange: (value: string) => void; open: () => boolean; setOpen: (open: boolean) => void; keys?: (id: string) => RowKeys }) {
  const open = Object.assign(() => props.open(), { set: props.setOpen });
  const choices = () => selectableChoices(props.descriptor);
  const value = () => currentValue(props.descriptor);
  const label = () => choices().find((choice) => choice.id === value())?.label ?? "";
  return (
    <View>
      <View class="min-h-8 w-full flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent" onPress={() => open.set(!open())} ref={props.keys ? (node: ViewRef | null) => props.keys!(props.descriptor.id).register(props.descriptor.id, node) : undefined} onFocus={props.keys ? () => props.keys!(props.descriptor.id).onFocus(props.descriptor.id) : undefined} accessibilityLabel={`${props.descriptor.label}: ${label()}`} role="button">
        <View class="min-w-0 flex-1">
          <Text class="truncate text-xs text-muted-foreground">{props.descriptor.label}</Text>
          <Text class="truncate text-sm text-foreground">{label()}</Text>
        </View>
        <ComposerIcon name={open() ? "chevron-up" : "chevron-down"} size={14} />
      </View>
      {open() ? (
        <View class="gap-0.5 ps-2" role="radiogroup" accessibilityLabel={props.descriptor.label}>
          <Each of={choices()} key={(choice) => choice.id}>
            {(choice) => (
              <LevelRow label={choice().label} description={choice().description} selected={choice().id === value()} isDefault={choice().isDefault} onPick={() => { props.onChange(choice().id); open.set(false); }} keys={props.keys?.(`${props.descriptor.id}:${choice().id}`)} />
            )}
          </Each>
        </View>
      ) : null}
    </View>
  );
}

function ToggleRow(props: { label: string; on: boolean; onChange: (next: boolean) => void; keys?: RowKeys }) {
  return (
    <View class="min-h-8 w-full flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent" onPress={() => props.onChange(!props.on)} ref={props.keys ? (node: ViewRef | null) => props.keys!.register(props.keys!.id, node) : undefined} onFocus={props.keys ? () => props.keys!.onFocus(props.keys!.id) : undefined} accessibilityLabel={`${props.label}: ${props.on ? "On" : "Off"}`} role="switch">
      <View class="min-w-0 flex-1">
        <Text class="truncate text-xs text-muted-foreground">{props.label}</Text>
        <Text class="truncate text-sm text-foreground">{props.on ? "On" : "Off"}</Text>
      </View>
      <View class={`h-4 w-7 justify-center rounded-full px-0.5 ${props.on ? "items-end bg-primary" : "items-start bg-input-32"}`}>
        <View class="size-3 rounded-full bg-white" />
      </View>
    </View>
  );
}

function EffortRows(props: { control: ColumnControl; onChange: (id: string, value: string | boolean) => void; keys?: (id: string) => RowKeys }) {
  const control = props.control;
  if (control.kind === "boolean") {
    const on = control.descriptor.currentValue === true;
    return (
      <View class="gap-0.5" role="radiogroup" accessibilityLabel={control.descriptor.label}>
        <LevelRow label="On" selected={on} onPick={() => props.onChange(control.descriptor.id, true)} keys={props.keys?.(`${control.descriptor.id}:on`)} />
        <LevelRow label="Off" selected={!on} onPick={() => props.onChange(control.descriptor.id, false)} keys={props.keys?.(`${control.descriptor.id}:off`)} />
      </View>
    );
  }
  const value = currentValue(control.descriptor);
  return (
    <View class="gap-0.5" role="radiogroup" accessibilityLabel={control.descriptor.label}>
      <Each of={selectableChoices(control.descriptor)} key={(option) => option.id}>
        {(option) => (
          <LevelRow label={option().label} description={option().description} selected={option().id === value} isDefault={option().isDefault} onPick={() => props.onChange(control.descriptor.id, option().id)} keys={props.keys?.(`${control.descriptor.id}:${option().id}`)} />
        )}
      </Each>
    </View>
  );
}

export const ULTRATHINK_IN_BODY_NOTE = 'Your prompt contains "ultrathink" in the text. Remove it to change this option.';

export function EffortColumn(props: {
  descriptors: () => Descriptor[];
  modelLabel: () => string;
  onChange: (id: string, value: string | boolean) => void;
  /** TraitsPicker ultrathinkInBodyText: the prompt names "ultrathink", so the effort rows are locked with a note. */
  ultrathinkInBody?: () => boolean;
  /** Filled with the column's keyboard (Up/Down between rows, Right/Left on an option, focus on open); see EffortBridge. */
  bridge?: { current: EffortBridge | null };
  /** A row took the keyboard focus. */
  onFocusZone?: () => void;
}) {
  const controls = () => columnControls(traitsView(props.descriptors()));
  const header = () => controls().effort?.descriptor.label ?? (controls().others.length ? "Options" : "Effort");
  const refs = new Map<string, ViewRef>();
  const focused = signal<string | null>(null);
  const openSelects = signal<ReadonlySet<string>>(new Set());
  const setSelectOpen = (id: string, open: boolean) => openSelects.update((current) => { const next = new Set(current); if (open) next.add(id); else next.delete(id); return next; });
  const keys = (id: string): RowKeys => ({ id, register: (key, node) => { if (node) refs.set(key, node); else refs.delete(key); }, onFocus: (key) => { focused.set(key); props.onFocusZone?.(); } });
  // The rows the arrows walk, in drawing order: the levels, then each option (and its choices while it is open).
  const locked = () => props.ultrathinkInBody?.() === true;
  const order = (): string[] => {
    const ids: string[] = [];
    const effort = controls().effort;
    if (effort && !locked()) {
      if (effort.kind === "boolean") ids.push(`${effort.descriptor.id}:on`, `${effort.descriptor.id}:off`);
      else ids.push(...selectableChoices(effort.descriptor).map((option) => `${effort.descriptor.id}:${option.id}`));
    }
    for (const control of controls().others) {
      ids.push(control.descriptor.id);
      if (control.kind !== "boolean" && openSelects().has(control.descriptor.id)) ids.push(...selectableChoices(control.descriptor as SelectDescriptor).map((choice) => `${control.descriptor.id}:${choice.id}`));
    }
    return ids;
  };
  const selectedLevel = (): string | null => {
    const effort = controls().effort;
    if (!effort || locked()) return null;
    return effort.kind === "boolean" ? `${effort.descriptor.id}:${effort.descriptor.currentValue === true ? "on" : "off"}` : `${effort.descriptor.id}:${currentValue(effort.descriptor)}`;
  };
  const focusId = (id: string | undefined): boolean => { const node = id ? refs.get(id) : undefined; if (!node) return false; node.focus(); return true; };
  if (props.bridge) props.bridge.current = {
    focus: (rows) => {
      const levels = controls().effort && !locked() ? order().filter((id) => id.startsWith(`${controls().effort!.descriptor.id}:`)) : [];
      const target = selectedLevel();
      if (focusId(target && levels.includes(target) ? target : levels[0])) return true;
      return rows === "any" ? focusId(order()[0]) : false;
    },
    step: (direction) => {
      const rows = order();
      const at = rows.indexOf(focused() ?? "");
      focusId(rows[Math.min(rows.length - 1, Math.max(0, at + direction))]);
    },
    right: () => {
      const id = focused();
      if (id && controls().others.some((control) => control.kind !== "boolean" && control.descriptor.id === id)) setSelectOpen(id, true);
    },
    left: () => {
      const id = focused();
      if (!id) return false;
      const owner = [...openSelects()].find((open) => id === open || id.startsWith(`${open}:`));
      if (owner === undefined) return false;
      setSelectOpen(owner, false);
      focusId(owner);
      return true;
    },
  };
  return (
    <View class="h-full w-48 border-l border-border-70" style={{ backgroundColor: overGlass("muted", 0.4) }} accessibilityLabel="Effort">
      <View class="px-3 pt-2.5">
        <View class="h-8 flex-row items-center gap-2 border-b border-border-70 pb-1.5">
          <Text class="text-sm text-muted-foreground">{header()}</Text>
          <View class="min-w-0 flex-1 items-end"><Text class="truncate text-xs text-muted-foreground">{props.modelLabel()}</Text></View>
        </View>
      </View>
      <Scroll class="min-h-0 flex-1">
        <View class="gap-0.5 px-2 pt-2.5 pb-1.5">
          {!controls().effort && controls().others.length === 0 ? (
            <View class="h-8 justify-center px-2"><Text class="text-sm text-muted-foreground">No effort levels</Text></View>
          ) : null}
          {controls().effort && props.ultrathinkInBody?.() ? <Text class="px-2 pb-1.5 text-xs text-muted-foreground-80">{ULTRATHINK_IN_BODY_NOTE}</Text> : null}
          {controls().effort ? <View class={props.ultrathinkInBody?.() ? "opacity-64" : ""} disabled={props.ultrathinkInBody?.() === true}><EffortRows control={controls().effort as ColumnControl} onChange={(id, value) => { if (!props.ultrathinkInBody?.()) props.onChange(id, value); }} keys={keys} /></View> : null}
          {controls().others.length > 0 ? (
            <View class={`gap-0.5 ${controls().effort ? "mt-1 border-t border-border-70 pt-1" : ""}`}>
              <Each of={controls().others} key={(control) => control.descriptor.id}>
                {(control) => control().kind === "boolean"
                  ? <ToggleRow label={control().descriptor.label} on={(control().descriptor as { currentValue?: boolean }).currentValue === true} onChange={(next) => props.onChange(control().descriptor.id, next)} keys={keys(control().descriptor.id)} />
                  : <SelectRow descriptor={control().descriptor as SelectDescriptor} onChange={(value) => props.onChange(control().descriptor.id, value)} open={() => openSelects().has(control().descriptor.id)} setOpen={(open) => setSelectOpen(control().descriptor.id, open)} keys={keys} />}
              </Each>
            </View>
          ) : null}
        </View>
      </Scroll>
    </View>
  );
}
