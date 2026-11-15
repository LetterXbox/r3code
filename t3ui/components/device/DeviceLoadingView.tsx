// DeviceLoadingView.tsx (components/device/DeviceLoadingView.tsx): the device name, a status line with a spinner, an
// optional action, and a two-step bar (open device, connect video). A failure drops the spinner and the bar.
import { Text, token, View } from "nsh";
import { Spinner } from "../sidebar/Spinner";
import { tokenAlpha } from "../composer/tokenColor";
import { DIcon } from "./DeviceIcons";

/** The step bar's accessible label. */
export function loadingStepLabel(stage: "opening" | "stream"): string {
  return stage === "opening" ? "Step 1 of 2: open device" : "Step 2 of 2: connect video";
}

export function DeviceLoadingView(props: {
  name: string;
  description?: string;
  stage: "opening" | "stream";
  message: string;
  error?: boolean;
  children?: any;
}) {
  return (
    <View {...(props.error ? { role: "alert" as const } : {})} accessibilityLabel={props.message} class="min-h-0 w-full flex-1 items-center justify-center bg-background px-6 py-10">
      <View class="max-w-sm items-center gap-3">
        <View class="size-12 items-center justify-center rounded-xl border border-border" style={{ backgroundColor: tokenAlpha("muted", 0.3) }}><DIcon name="smartphone" size={24} tint={String(token("muted-foreground"))} /></View>
        <View class="items-center gap-1">
          <Text class="text-sm font-medium text-foreground">{props.name}</Text>
          {props.description ? <Text class="text-center text-xs text-muted-foreground">{props.description}</Text> : null}
        </View>
        <View class="flex-row items-center gap-2">
          {!props.error ? <Spinner size={12} /> : null}
          <Text class="text-center text-xs text-muted-foreground">{props.message}</Text>
        </View>
        {props.children}
        {!props.error ? (
          <View class="w-24 flex-row gap-1" accessibilityLabel={loadingStepLabel(props.stage)}>
            <View class="h-1 flex-1 rounded-full bg-foreground opacity-60" />
            <View class={`h-1 flex-1 rounded-full ${props.stage === "stream" ? "bg-foreground opacity-60" : "bg-muted"}`} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
