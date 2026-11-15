// The page-level "could not load" state, ported from PullRequestsUnavailableState.tsx.
import { openUrl, Text, View } from "nsh";
import { PRIcon } from "./PRIcon";

function Button(props: { label: string; icon: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ busy: props.disabled === true }}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class={props.disabled ? "h-8 flex-row items-center gap-1.5 rounded-md border border-border px-3 opacity-50" : "h-8 flex-row items-center gap-1.5 rounded-md border border-border px-3 hover:bg-accent-50"}
    >
      <PRIcon name={props.icon} size={14} />
      <Text class="text-sm text-foreground">{props.label}</Text>
    </View>
  );
}

export function PullRequestsUnavailableState(props: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
  host?: { url: string; openLabel: string };
}) {
  return (
    <View class="min-w-0 flex-1 flex-col items-center justify-center gap-6 p-12">
      <View class="size-9 items-center justify-center rounded-md border border-border bg-card"><PRIcon name="git-pull-request-arrow" size={18} /></View>
      <View class="max-w-sm flex-col items-center gap-1">
        <Text class="text-center text-lg font-semibold text-foreground">{props.title ?? "Could not load pull requests"}</Text>
        <Text class="text-center text-sm text-muted-foreground">{props.error}</Text>
      </View>
      {props.onRetry || props.host ? (
        <View class="flex-row flex-wrap justify-center gap-2">
          {props.onRetry ? <Button label="Retry" icon="refresh-cw" disabled={props.refreshing === true} onPress={props.onRetry} /> : null}
          {props.host ? <Button label={props.host.openLabel} icon="external-link" onPress={() => void openUrl(props.host!.url)} /> : null}
        </View>
      ) : null}
    </View>
  );
}

