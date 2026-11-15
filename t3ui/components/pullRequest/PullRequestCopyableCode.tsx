// A code snippet that copies itself when pressed, and says "Copied" for a moment (PullRequestCopyableCode.tsx).
import { Clipboard, signal, Text, View } from "nsh";

export function PullRequestCopyableCode(props: { value: string; copyLabel: string; copiedLabel: string; class?: string; onError?: (message: string) => void }) {
  const copied = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function copy() {
    Clipboard.writeText(props.value).then(() => {
      copied.set(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => copied.set(false), 1600);
    }).catch((cause: unknown) => props.onError?.(cause instanceof Error ? cause.message : String(cause)));
  }
  return (
    <View
      role="button"
      tooltip={`${copied() ? "Copied" : props.copyLabel}: ${props.value}`}
      accessibilityLabel={copied() ? props.copiedLabel : props.copyLabel}
      onPress={copy}
      class={`min-w-0 max-w-full shrink rounded px-1 py-0.5 hover:bg-accent-50 transition-colors duration-150 ease-in-out ${props.class ?? ""}`}
    >
      <Text class="min-w-0 truncate font-mono text-xs text-muted-foreground">{copied() ? "Copied" : props.value}</Text>
    </View>
  );
}

