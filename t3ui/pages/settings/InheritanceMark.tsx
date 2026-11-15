// SettingInheritance.tsx: the layers mark beside a scoped row's title. It opens a popover that lists where the value
// comes from (Project, the environment, Default) with a check on the winner, and, outside a project scope, the
// projects that override it with a "Reset" link.
import { signal, Text, token, View } from "nsh";
import { createAnchor, Popup } from "../../components/composer/Popover";
import { SettingsIcon } from "./SettingsIcon";
import { clearProjectOverrides, inheritanceFor, layersFor, overridingProjectIds, scopeProjects, selectScope, settingsOverrideValue } from "./scopeState";
import { formatSettingValue } from "./scopeCore";
import { Presence } from "../../components/motion/Motion";
import { DURATION_DEFAULT_MS } from "../../components/motion/motionTokens";


export function InheritanceMark(props: { title: string; keys: readonly string[]; rowHovered?: () => boolean }) {
  const open = signal(false);
  const anchor = createAnchor();
  const key = props.keys[0]!;
  const info = () => inheritanceFor(props.keys);
  const overriding = () => overridingProjectIds(props.keys);
  // Values set right here explain nothing new, so their mark waits for a hover (`opacity-0 group-hover`).
  const quiet = () => (info().state === "default" || info().state === "environment") && overriding().length === 0 && !open();
  const hovered = signal(false);
  const focused = signal(false);
  const revealed = () => hovered() || focused() || (props.rowHovered?.() ?? false);
  const tint = () => (info().state === "overridden" ? token("primary") : token("muted-foreground"));
  return (
    <View onMouseEnter={() => hovered.set(true)} onMouseLeave={() => hovered.set(false)} class="size-5 items-center justify-center">
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel={`${info().summary}${overriding().length > 0 ? ` · ${overriding().length} project ${overriding().length === 1 ? "override" : "overrides"}` : ""}. Show where this value comes from`}
        onPress={() => open.set(!open())}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        class={`size-5 items-center justify-center rounded-md hover:bg-accent ${quiet() && !revealed() ? "opacity-0" : ""}`}
      >
        <SettingsIcon name="layers" size={12} tint={tint()} />
      </View>
      <Presence when={open} ms={DURATION_DEFAULT_MS}>{(closing) => (
        <Popup animated closing={closing} anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="start" class="w-80">
          <View class="px-3 py-2.5" testID={`Inheritance ${props.title}`}>
            <Each of={layersFor(key)} key={(layer) => layer.key}>
              {(layer) => (
                <View class={`flex-row items-center gap-3 rounded-md px-2 py-1 ${layer().effective ? "bg-accent-50" : ""}`}>
                  <Text class={`min-w-0 flex-1 truncate text-sm ${layer().effective ? "font-medium text-foreground" : "text-muted-foreground"}`}>{layer().key === "environment" ? "Environment" : layer().label}</Text>
                  <Text class={`max-w-32 truncate text-sm ${layer().effective ? "text-foreground" : "text-muted-foreground"}`}>{layer().value}</Text>
                  <View class="size-3.5 items-center justify-center">{layer().effective ? <SettingsIcon name="check" size={14} tint={token("primary")} /> : null}</View>
                </View>
              )}
            </Each>
            {overriding().length > 0 ? (
              <View class="mt-2 gap-0.5 border-t border-border-60 pt-2">
                <View class="flex-row items-center justify-between px-2">
                  <Text class="text-xs text-muted-foreground">Overridden by</Text>
                  <View role="button" accessibilityLabel={`Reset ${overriding().length === 1 ? "it" : "all"}`} onPress={() => { void clearProjectOverrides(overriding(), props.keys); open.set(false); }}>
                    <Text class="text-xs text-primary">Reset {overriding().length === 1 ? "it" : "all"}</Text>
                  </View>
                </View>
                <Each of={overriding()} key={(id) => id}>
                  {(id) => (
                    <View class="flex-row items-center gap-3 px-2 py-1">
                      <View role="button" class="min-w-0 flex-1" onPress={() => { selectScope({ project: id() }); open.set(false); }}>
                        <Text class="truncate text-sm text-primary">{scopeProjects().find((project) => project.id === id())?.name ?? id()}</Text>
                      </View>
                      <Text class="max-w-32 truncate text-sm text-muted-foreground">{formatSettingValue(key, settingsOverrideValue(id(), key))}</Text>
                    </View>
                  )}
                </Each>
              </View>
            ) : null}
          </View>
        </Popup>
      )}</Presence>
    </View>
  );
}
