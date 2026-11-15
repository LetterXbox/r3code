// PullRequestActorLabel / PullRequestActorAvatar from pullRequestPresentation.tsx: a 16 px avatar and the login.
import { Image, Text, View } from "nsh";

export function PullRequestActorAvatar(props: { actor: { avatarUrl?: string } | null; size?: number }) {
  const size = props.size ?? 16;
  const url = props.actor?.avatarUrl ?? "";
  return url
    ? <View class="shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}><Image src={url} style={{ width: size, height: size }} /></View>
    : <View class="shrink-0 rounded-full bg-muted" style={{ width: size, height: size }} />;
}

export function PullRequestActorLabel(props: { actor: { login: string; avatarUrl?: string } | null; variant?: "label" | "avatar" }) {
  return (
    <View class="min-w-0 shrink flex-row items-center gap-1.5">
      <PullRequestActorAvatar actor={props.actor} />
      {props.variant === "avatar" ? null : <Text class="min-w-0 shrink truncate text-xs font-medium text-foreground">{props.actor?.login ?? "ghost"}</Text>}
    </View>
  );
}

