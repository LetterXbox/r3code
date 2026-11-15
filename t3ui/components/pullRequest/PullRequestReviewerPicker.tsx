// PullRequestReviewerPicker.tsx on PullRequestCandidatePicker: a user-plus button that opens a
// searchable list of the people with access, ticked when a review is already requested.
import { Image, Text, View } from "nsh";
import { PRIcon } from "./PRIcon";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";
import type { ReviewerCandidate, ReviewerPickerGate } from "./pullRequestEditing.logic";

export function PullRequestReviewerPicker(props: { gate: ReviewerPickerGate; actions: PullRequestActionsModel }) {
  const actions = props.actions;
  // The gate is fixed for one pull request's detail, and the parent re-mounts the row per detail.
  if (!props.gate.available) return null;
  return (
    <PullRequestCandidatePicker<ReviewerCandidate>
      icon="user-plus"
      label="Request a review"
      allowed={props.gate.allowed}
      disabledReason="Asking someone to review needs write access on this repository"
      open={actions.reviewersOpen}
      onToggle={() => actions.toggleReviewersMenu()}
      query={actions.reviewerQuery}
      onQueryChange={(query) => actions.reviewerQuery.set(query)}
      searchLabel="Search people with access"
      isPending={actions.reviewersPending}
      error={actions.reviewersListError}
      candidates={actions.visibleReviewers}
      emptyLabel="Nobody else has access to this repository."
      noMatchLabel="Nobody with access matches that."
      errorLabel="The people with access could not be read."
      truncatedLabel={actions.reviewersTruncationNote}
      candidateKey={(candidate) => `Reviewer ${candidate.login}`}
      disabled={() => actions.reviewerPending() !== null}
      onSelect={(candidate) => void actions.toggleReviewer(candidate)}
      row={(candidate) => (
        <>
          {candidate.avatarUrl
            ? <View class="size-4 shrink-0 overflow-hidden rounded-full"><Image src={candidate.avatarUrl} style={{ width: 16, height: 16 }} /></View>
            : <View class="size-4 shrink-0 rounded-full bg-muted" />}
          <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{candidate.login}</Text>
          {candidate.kind === "team" ? <Text class="shrink-0 text-xs text-muted-foreground">team</Text> : null}
          {candidate.isRequested ? <View accessibilityLabel="Already asked"><PRIcon name="check" size={14} /></View> : null}
        </>
      )}
      footer={() => (
        <>
          {actions.reviewerError() && actions.reviewersStatus() !== "error" ? <Text class="px-2 py-1.5 text-xs text-destructive">{actions.reviewerError()}</Text> : null}
          {actions.reviewerNotice() ? <Text class="px-2 py-1.5 text-xs text-muted-foreground">{actions.reviewerNotice()}</Text> : null}
        </>
      )}
    />
  );
}

