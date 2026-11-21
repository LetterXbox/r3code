// Floating comment composer for IssueDetailPanel (IssueCommentComposer.tsx).
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Spinner } from "../sidebar/Spinner";
import { PRIcon } from "../pullRequest/PRIcon";
import { showToast } from "../toast";
import type { IssueRef } from "./issueLogic";
import { commentOnIssue, type RequestFn } from "./issueStore";

export function IssueCommentComposer(props: {
  environmentId: string;
  reference: IssueRef;
  /** Why the viewer cannot comment here; null when allowed. */
  blocked: string | null;
  request?: RequestFn;
}) {
  const body = signal("");
  const submitting = signal(false);

  const locked = () => props.blocked !== null || submitting();
  const submitDisabled = () => locked() || body().trim().length === 0;

  async function submit() {
    const text = body().trim();
    if (!text || locked()) return;
    submitting.set(true);
    try {
      await commentOnIssue(props.environmentId, { ...props.reference, body: text }, props.request);
      body.set("");
    } catch (cause) {
      showToast({
        type: "error",
        title: "The comment could not be posted",
        description: cause instanceof Error ? cause.message : "The tracker refused it.",
      });
    } finally {
      submitting.set(false);
    }
  }

  return (
    <View class="shrink-0 border-t border-border-60 bg-background px-3 py-2.5">
      <View class="flex-col gap-2 rounded-xl border border-input bg-card px-3 py-2">
        <Input
          multiline
          accessibilityLabel="Add a comment"
          placeholder={props.blocked ?? "Leave a comment"}
          disabled={locked()}
          value={body()}
          onChange={(event) => body.set(event.value)}
          onKeyPress={(event) => {
            if (event.key === "Enter" && (event.modifiers.platform || event.modifiers.control) && !event.modifiers.shift) {
              void submit();
            }
          }}
          class="min-h-12 w-full bg-transparent text-sm text-foreground"
        />
        <View class="flex-row items-center justify-end gap-2">
          <View
            role="button"
            accessibilityLabel="Send comment"
            accessibilityState={{ disabled: submitDisabled() }}
            onPress={() => void submit()}
            class={submitDisabled()
              ? "size-7 items-center justify-center rounded-full bg-muted opacity-50"
              : "size-7 items-center justify-center rounded-full bg-primary hover:opacity-90 active:scale-[0.97] transition-all duration-150 ease-in-out"}
          >
            {submitting() ? <Spinner size={14} /> : <PRIcon name="send" size={14} />}
          </View>
        </View>
      </View>
    </View>
  );
}
