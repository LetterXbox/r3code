// The picker footer's speed and Ultracode segments (SpeedControl / UltracodeControl in
// chat/ComposerModelEffort.tsx): a service-tier select or Claude's Fast mode toggle as a
// segmented group, and Ultracode as a pressed toggle.
import { Text, View } from "nsh";
import { ComposerIcon } from "./ComposerIcon";
import { currentValue, selectableChoices, splitSpeed, traitsView } from "./modelTraits";
import type { Descriptor } from "./modelTraits";

function Segment(props: { label: string; checked: boolean; onPick: () => void; icon?: string }) {
  return (
    <View
      class={`h-6 flex-row items-center justify-center gap-1 px-2 ${props.checked ? "bg-input-32" : "hover:bg-accent-50"}`}
      onPress={props.onPick}
      accessibilityLabel={props.label}
      role="radio"
    >
      {props.icon ? <ComposerIcon name={props.icon} size={12} /> : null}
      <Text class={`text-xs ${props.checked ? "text-foreground" : "text-muted-foreground"}`}>{props.label}</Text>
    </View>
  );
}

export function SpeedControls(props: { descriptors: () => Descriptor[]; onChange: (id: string, value: string | boolean) => void }) {
  const parts = () => splitSpeed(traitsView(props.descriptors()));
  return (
    <>
      {parts().speedSelect ? (
        <View class="flex-row overflow-hidden rounded-lg bg-input-32 p-0.5" role="radiogroup" accessibilityLabel={parts().speedSelect!.label}>
          <Each of={selectableChoices(parts().speedSelect!)} key={(option) => option.id}>
            {(option) => <Segment label={option().label} checked={option().id === currentValue(parts().speedSelect!)} onPick={() => props.onChange(parts().speedSelect!.id, option().id)} />}
          </Each>
        </View>
      ) : parts().fastToggle ? (
        <View class="flex-row overflow-hidden rounded-lg bg-input-32 p-0.5" role="radiogroup" accessibilityLabel={parts().fastToggle!.label}>
          <Segment label="Standard" checked={parts().fastToggle!.currentValue !== true} onPick={() => props.onChange(parts().fastToggle!.id, false)} />
          <Segment label="Fast" icon="zap" checked={parts().fastToggle!.currentValue === true} onPick={() => props.onChange(parts().fastToggle!.id, true)} />
        </View>
      ) : null}
      {parts().ultracodeToggle ? (
        <View class="flex-row overflow-hidden rounded-lg bg-input-32 p-0.5">
          <Segment label={parts().ultracodeToggle!.label} icon="workflow" checked={parts().ultracodeToggle!.currentValue === true} onPick={() => props.onChange(parts().ultracodeToggle!.id, parts().ultracodeToggle!.currentValue !== true)} />
        </View>
      ) : null}
    </>
  );
}
