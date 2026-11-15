// The web's AdvancedSettings (components/settings/AdvancedSettings.tsx): power-user rows folded at
// the end of a card behind an "Advanced" toggle, closed until pressed (or until a search jump lands inside).
import { signal, Text, View } from "nsh";
import { SettingsIcon } from "./SettingsIcon";
import { toggleWithLayout } from "../../components/motion/Motion";
import { COLLAPSE_MS } from "../../components/motion/motionTokens";

export function AdvancedFold(props: { children: any; forceOpen?: () => boolean }) {
  const open = signal(false);
  const shown = () => open() || props.forceOpen?.() === true;
  return (
    <View>
      <View class="h-px bg-border-50" />
      <View
        accessibilityLabel="Advanced"
        accessibilityState={{ expanded: shown() }}
        testID={`Advanced (${shown() ? "open" : "closed"})`}
        onPress={() => toggleWithLayout(COLLAPSE_MS, () => open.set(!open()))}
        class={`min-h-10 flex-row items-center gap-1.5 px-4 ${shown() ? "" : "rounded-b-xl"}`}
      >
        <View class={`transition-transform duration-150 motion-reduce:transition-none ${shown() ? "rotate-90" : ""}`}><SettingsIcon name="chevron-right" size={14} /></View>
        <Text class="text-xs font-medium text-muted-foreground">Advanced</Text>
      </View>
      {/* The always-mounted clip lets the toggle's LayoutAnimation grow the frame while the content is cut at its edge (ui/collapsible.tsx:29 height 200ms). */}
      <View class="overflow-hidden">{shown() ? <View>{props.children}</View> : null}</View>
    </View>
  );
}
