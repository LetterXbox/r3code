// The repository and number above the title (PullRequestDetailCrumbs.tsx). The number opens the pull request
// on its host and offers Copy link / Open on the host to a right press. The web swaps the row for the number
// and title once the title has scrolled away; a native column does not report that, so the plain row stays.
import { openUrl, Text, View } from "nsh";
import { PRIcon } from "./PRIcon";
import { PullRequestLinkMenu } from "./PullRequestLinkMenu";
import { openOnHostLabel } from "./pullRequestLinkContextMenu";
import { changeRequestTerm } from "./pullRequestCheckout.logic";

export function PullRequestDetailCrumbs(props: {
  detail: { url: string; provider: string; number: number; repository: string } | null;
  tone: string | null;
  repositoryUrl: string | null;
  onBack?: () => void;
  onOpen: (url: string) => void;
}) {
  const detail = () => props.detail;
  return (
    <View class="h-7 min-w-0 flex-1 flex-row items-center gap-1 overflow-hidden pl-4" accessibilityLabel="Pull request crumbs">
      {detail() && props.onBack ? (
        <View role="button" tooltip="Back to pull requests" accessibilityLabel="Back to this thread's pull requests" onPress={props.onBack} class="-ml-1.5 size-5 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"><PRIcon name="arrow-left" size={14} /></View>
      ) : null}
      {detail() ? (
        <>
          {props.repositoryUrl ? (
            <View role="link" tooltip={`Open ${detail()!.repository} repository`} accessibilityLabel={`Open ${detail()!.repository} repository`} onPress={() => void openUrl(props.repositoryUrl as string)} class="min-w-0 shrink">
              <Text class="min-w-0 truncate text-xs font-medium text-muted-foreground hover:text-foreground">{detail()!.repository}</Text>
            </View>
          ) : <Text class="min-w-0 truncate text-xs font-medium text-muted-foreground">{detail()!.repository}</Text>}
          <PullRequestLinkMenu url={detail()!.url} provider={detail()!.provider}>
            <View
              role="link"
              tooltip={openOnHostLabel(detail()!.provider)}
              accessibilityLabel={`Open ${changeRequestTerm(detail()!.provider)} #${detail()!.number} on host`}
              onPress={() => props.onOpen(detail()!.url)}
              class="shrink-0 flex-row items-center gap-0.5"
            >
              <Text class="text-xs font-medium" style={props.tone ? { color: props.tone } : undefined}>{`#${detail()!.number}`}</Text>
              <PRIcon name="external-link" size={10} />
            </View>
          </PullRequestLinkMenu>
        </>
      ) : null}
    </View>
  );
}

