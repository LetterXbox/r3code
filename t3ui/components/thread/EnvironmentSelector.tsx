// The composer strip's "Run on" control (BranchToolbarEnvironmentSelector.tsx): a trigger naming the machine
// the thread runs on, with a "Run on" menu of the available environments (composer.host opens it). A started
// thread, or a single machine, shows the same row locked.
import { effect, signal, Text, untracked, View } from "nsh";
import { ComposerIcon } from "../composer/ComposerIcon";
import { createAnchor } from "../composer/Popover";
import { RadioMenu } from "../composer/RadioMenu";
import type { RadioMenuItem } from "../composer/RadioMenu";
import { tokenAlpha } from "../composer/tokenColor";
import type { EnvironmentOption } from "./environmentOptions";
import { ContextLabel } from "./ContextLabel";

export function EnvironmentSelector(props: {
  options: () => EnvironmentOption[];
  activeId: () => string | null;
  /** A started thread cannot move machines. */
  locked: () => boolean;
  disabled: () => boolean;
  onSelect: (option: EnvironmentOption) => void;
  shortcutLabel?: () => string | null;
  /** composer.host: a counter that opens the menu each time it changes. */
  openRequests?: () => number;
  /** "Add to another machine" (BranchToolbar.tsx): connected machines the project can be cloned to. */
  addTargets?: () => { key: string; label: string; machine: "laptop" | "server" }[];
  onAddToMachine?: (key: string) => void;
  /** useDraftEnvironmentRouting autoEnvironmentLabel: set while the draft routes automatically. */
  autoLabel?: () => string | undefined;
  /** onAutoEnvironment: offered (as the first "Run on" item) while load balancing can route this draft. */
  onAuto?: () => (() => void) | undefined;
}) {
  const open = signal(false);
  const anchor = createAnchor();
  const active = () => props.options().find((item) => item.environmentId === props.activeId()) ?? null;
  const auto = () => props.autoLabel?.();
  const label = () => auto() ?? active()?.label ?? "Run on";
  const pickable = () => (!props.locked() && (props.options().length > 1 || props.onAuto?.() !== undefined)) || (props.addTargets?.().length ?? 0) > 0;

  let seen = untracked(() => props.openRequests?.() ?? 0);
  effect(() => {
    const requests = props.openRequests?.() ?? 0;
    if (requests === seen) return;
    seen = requests;
    if (untracked(pickable) && !untracked(props.disabled)) open.set(true);
  });

  const autoItems = (): RadioMenuItem[] => { const run = props.onAuto?.(); return run ? [{
    value: "action:auto", label: auto() ?? "Auto balance", checked: auto() !== undefined, onSelect: run,
    content: (
      <View class="min-w-0 flex-row items-center gap-1.5">
        <ComposerIcon name="scale" size={12} />
        <Text class="min-w-0 truncate text-sm text-foreground">{auto() ?? "Auto balance"}</Text>
      </View>
    ),
  }] : []; };
  const items = (): RadioMenuItem[] => autoItems().concat(props.options().map((option) => ({
    value: option.environmentId, label: option.label, checked: auto() === undefined && option.environmentId === props.activeId(),
    onSelect: () => props.onSelect(option),
    content: (
      <View class="min-w-0 flex-row items-center gap-1.5">
        <ComposerIcon name={option.machine} size={12} />
        <Text class="min-w-0 truncate text-sm text-foreground">{option.label}</Text>
      </View>
    ),
  })).concat((props.addTargets?.() ?? []).map((target) => ({
    value: `add:${target.key}`, label: `Add to another machine: ${target.label}`, checked: false,
    onSelect: () => props.onAddToMachine?.(target.key),
    content: (
      <View class="min-w-0 flex-row items-center gap-1.5">
        <ComposerIcon name="plus" size={12} />
        <Text class="min-w-0 truncate text-sm text-foreground">Add to another machine</Text>
        <ComposerIcon name={target.machine} size={12} />
        <Text class="min-w-0 truncate text-sm text-muted-foreground">{target.label}</Text>
      </View>
    ),
  }))));

  const row = (muted: boolean) => (
    <>
      <ComposerIcon name={auto() !== undefined ? "scale" : active()?.machine ?? "server"} size={12} />
      <ContextLabel text={label} {...(muted ? { style: { color: tokenAlpha("muted-foreground", 0.7) } } : {})} />
    </>
  );
  return (
    <View class="min-w-0 shrink">
      {!pickable() ? (
        <View class="h-6 min-w-0 flex-row items-center gap-1.5 border border-transparent px-[7px]" accessibilityLabel="Run on" accessibilityHint={label()}>{row(true)}</View>
      ) : (
        <View>
          <View
            ref={anchor.ref}
            class={`h-6 min-w-0 flex-row items-center gap-1.5 rounded-md border border-transparent px-[7px] ${open() ? "bg-accent" : "hover:bg-accent"} ${props.disabled() ? "opacity-64" : ""}`}
            disabled={props.disabled()}
            tooltip={`${label()}${props.shortcutLabel?.() ? ` · ${props.shortcutLabel()}` : ""}`}
            onPress={() => open.set(!open())}
            accessibilityLabel="Run on"
            accessibilityHint={label()}
            role="button"
          >{row(false)}</View>
          {open() ? <RadioMenu anchor={anchor.anchor} onClose={() => open.set(false)} group="Run on" items={items} class="w-56" /> : null}
        </View>
      )}
    </View>
  );
}
