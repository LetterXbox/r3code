// The "Usage limits" banner above the composer: info variant, gauge mark, the provider and plan,
// one row per window, and a dismiss control.
import { Text, View } from "nsh";
import { formatResetsIn, paceOf, remainingPercent, PACE_LABEL } from "../usage/usageFormat";
import type { UsageLimitWindow } from "../../pages/utility-data";
import { ComposerIcon } from "./ComposerIcon";
import type { LimitsView } from "./usageLimitsLogic";

function toWindow(window: LimitsView["windows"][number]): UsageLimitWindow {
  return { id: window.id, label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt ?? "", windowDurationMins: window.windowDurationMins };
}

export function UsageLimitsBanner(props: { title: string; limits: () => LimitsView; now: () => number; onDismiss: () => void }) {
  return (
    <View class="mb-2 flex-row items-start gap-2 rounded-lg border border-border bg-card px-3 py-2" accessibilityLabel="Usage limits">
      <ComposerIcon name="gauge" size={16} />
      <View class="min-w-0 flex-1 gap-1">
        <Text class="text-sm font-medium text-foreground">Usage limits</Text>
        <Text class="text-xs text-muted-foreground">{props.title}</Text>
        {props.limits().notice ? <Text class="text-xs text-muted-foreground">{props.limits().notice}</Text> : null}
        <Each of={props.limits().windows} key={(window) => window.id}>
          {(window) => {
            const view = () => toWindow(window());
            const remaining = () => remainingPercent(view());
            return (
              <View class="gap-0.5 py-0.5" accessibilityLabel={`${window().label}: ${remaining()}% left`}>
                <View class="flex-row items-center gap-2">
                  <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{window().label}</Text>
                  <Text class="text-xs font-medium text-foreground">{`${remaining()}% left`}</Text>
                </View>
                <View class="h-1.5 rounded-full bg-muted">
                  {remaining() > 0 ? <View class="h-1.5 rounded-full bg-primary" style={{ width: `${remaining()}%` }} /> : null}
                </View>
                <Text class="text-xs text-muted-foreground">
                  {[paceOf(view(), props.now()) ? PACE_LABEL[paceOf(view(), props.now())!] : null, window().resetsAt ? formatResetsIn(view(), props.now()) : null].filter(Boolean).join(" · ")}
                </Text>
              </View>
            );
          }}
        </Each>
        {props.limits().resetCredits ? <Text class="text-xs text-muted-foreground">{`${props.limits().resetCredits} reset credit${props.limits().resetCredits === 1 ? "" : "s"} available`}</Text> : null}
      </View>
      <View class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={props.onDismiss} accessibilityLabel="Dismiss usage limits" role="button">
        <ComposerIcon name="x" size={14} />
      </View>
    </View>
  );
}
