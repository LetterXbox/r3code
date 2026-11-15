// AssistantSelectionToolbar.tsx, AssistantCitationCommentEditor.tsx and AssistantCitationChip.tsx's composer variant,
// on the host's selection (hostSelection.ts, host patch 0011) instead of the DOM's.
import { cleanup, computed, keymap, Overlay, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { ViewRef } from "nsh";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { chipColor } from "../markdown/contextChips";
import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, ASSISTANT_CITATION_MAX_TEXT_LENGTH, assistantCitationLabel, collectAssistantCitations, type AssistantCitation } from "../markdown/assistantCitations";
import { EscapeCancel } from "../../EscapeCancel";
import { clearHostSelection, hostSelection, markHostRange, messageIdOfSource, sourceTexts, citationSourceTestId, type HostRect } from "./hostSelection";
import { captureAssistantTextSelection, resolveAssistantCitationRange } from "./citationText";
import { citeAssistantText, citationCommentEditor, closeCitationCommentEditor, goToCitationSource, openCitationCommentEditor, saveCitationComment } from "./citationState";
import { resolveAssistantCitationCommentDismissal } from "./citationProcedure";

/** isSelectionRectVisible: the rect's part inside every clip. */
export function isSelectionRectVisible(rect: HostRect, clips: readonly HostRect[]): boolean {
  let left = rect.x; let top = rect.y; let right = rect.x + rect.width; let bottom = rect.y + rect.height;
  for (const clip of clips) {
    left = Math.max(left, clip.x); top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width); bottom = Math.min(bottom, clip.y + clip.height);
  }
  return right > left && bottom > top;
}

/** resolveSelectionActionPosition without a pointer: under the selection's last line, at its end, inside the bounds. */
export function resolveSelectionActionPosition(options: { bounds: HostRect; selectionRect: HostRect | null; viewport: { width: number; height: number } }): { x: number; y: number } {
  const { bounds, selectionRect, viewport } = options;
  const preferred = { x: selectionRect ? selectionRect.x + selectionRect.width : bounds.x + bounds.width - 140, y: selectionRect ? selectionRect.y + selectionRect.height + 4 : bounds.y + 12 };
  return {
    x: Math.max(8, Math.min(Math.max(bounds.x, preferred.x), bounds.x + bounds.width, viewport.width - 8)),
    y: Math.max(8, Math.min(Math.max(bounds.y, preferred.y), bounds.y + bounds.height, viewport.height - 8)),
  };
}

/** The citation a host selection makes in thread `threadRef`, or null when it is not inside one cited message. */
export function citationFromSelection(threadRef: { environmentId: string; threadId: string }): { citation: AssistantCitation; lastRect: HostRect | null } | null {
  const selection = hostSelection();
  if (selection.empty || selection.pointerDown || !selection.source) return null;
  const messageId = messageIdOfSource(selection.source.testId);
  if (!messageId) return null;
  const selector = captureAssistantTextSelection(selection.source.texts, selection.source.start, selection.source.end);
  if (!selector) return null;
  return { citation: { version: 1, environmentId: threadRef.environmentId, threadId: threadRef.threadId, messageId, ...selector }, lastRect: selection.rects[selection.rects.length - 1] ?? selection.rect };
}

/** AssistantSelectionToolbar: "Cite" over selected assistant text; "Shorten selection" past the limit. */
export function AssistantSelectionToolbar(props: { threadRef: () => { environmentId: string; threadId: string } | null; viewport: () => HostRect | null; windowSize: () => { width: number; height: number }; hidden?: () => boolean }) {
  const dismissedFor = signal<unknown>(null);
  const captured = computed(() => {
    const ref = props.threadRef();
    if (!ref || props.hidden?.()) return null;
    const value = citationFromSelection(ref);
    if (!value || dismissedFor() === hostSelection()) return null;
    const viewport = props.viewport();
    const selection = hostSelection();
    if (viewport && !selection.empty && !selection.rects.some((line) => isSelectionRectVisible(line, [viewport]))) return null;
    return value;
  });
  const tooLong = () => (captured()?.citation.text.length ?? 0) > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const position = () => {
    const value = captured();
    const viewport = props.viewport();
    if (!value) return null;
    return resolveSelectionActionPosition({ bounds: viewport ?? { x: 0, y: 0, ...props.windowSize() }, selectionRect: value.lastRect, viewport: props.windowSize() });
  };
  const dismiss = () => dismissedFor.set(hostSelection());
  const cite = () => {
    const value = captured();
    if (!value || tooLong()) return;
    if (!citeAssistantText(value.citation, value.lastRect)) return;
    void clearHostSelection();
  };
  return captured() && position() ? (
    <Overlay anchor={position()!} placement="bottom" align="start" margin={8}>
      {/* Escape dismisses the toolbar (it keeps the selection). */}
      <EscapeCancel onCancel={dismiss} />
      <View
        class={`h-6 flex-row items-center gap-1 rounded-md border border-border bg-popover-84 px-2 shadow-md ${tooLong() ? "opacity-64" : "hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"}`}
        role="button"
        disabled={tooLong()}
        focusable
        accessibilityLabel={tooLong() ? "Selection is too long to cite" : "Cite selection in composer"}
        onPress={cite}
        testID="Cite selection"
      >
        <TimelineIcon name="quote" size={14} />
        <Text class="text-xs font-medium text-foreground">{tooLong() ? "Shorten selection" : "Cite"}</Text>
      </View>
    </Overlay>
  ) : null;
}

/** AssistantCitationCommentEditor, in its popover: below the cited text, or over the composer chip it was opened from. */
export function AssistantCitationCommentEditor(props: { anchor: HostRect | ViewRef; citation: AssistantCitation; source: string; onSubmitAndSend?: () => void; onRestoreFocus?: () => void }) {
  const comment = signal(props.citation.comment ?? "");
  let draft: string | null = null;
  const tooLong = () => comment().length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const update = (text: string) => { comment.set(text); draft = text; };
  const close = () => { closeCitationCommentEditor(); props.onRestoreFocus?.(); };
  const submit = (send: boolean) => {
    const text = comment();
    if (text.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) return;
    if (!saveCitationComment(props.source, text)) return;
    close();
    if (send) props.onSubmitAndSend?.();
  };
  /** The popover closing for `reason`: the dismissal rule decides whether the draft is saved, dropped or kept open. */
  const settle = (reason: string) => {
    const dismissal = resolveAssistantCitationCommentDismissal({ reason, draft, savedComment: props.citation.comment, maxLength: ASSISTANT_CITATION_MAX_COMMENT_LENGTH });
    if (dismissal.kind === "keep-open") return;
    if (dismissal.kind === "commit") saveCitationComment(props.source, dismissal.comment);
    close();
  };
  // observeAssistantCitationCommentSource: the cited text is highlighted while the editor is open, and the editor closes
  // (settling its draft) once the source goes away.
  if (!("measure" in (props.anchor as object))) {
    const testId = citationSourceTestId(props.citation.messageId);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (stopped) return;
      const found = await sourceTexts(testId);
      const range = found ? resolveAssistantCitationRange(found.texts, props.citation) : null;
      if (stopped) return;
      if (!range) { void markHostRange(null); settle("none"); return; }
      await markHostRange({ testId, start: range.start, end: range.end, alpha: 0.25 });
      timer = setTimeout(() => { void check(); }, 500);
    };
    void check();
    cleanup(() => { stopped = true; clearTimeout(timer); void markHostRange(null); });
  }
  cleanup(keymap.bind("mod+enter", () => submit(true), { when: "always" }));
  const anchor = props.anchor as HostRect;
  const overlayAnchor = "measure" in (props.anchor as object) ? (props.anchor as ViewRef) : { origin: { x: anchor.x, y: anchor.y }, size: { width: anchor.width, height: anchor.height } };
  return (
    <Overlay anchor={overlayAnchor} placement={"measure" in (props.anchor as object) ? "top" : "bottom"} align="end" offset={6} margin={8} onPressOutside={() => settle("outside-press")} onCancel={() => settle("escape-key")}>
      <View class="w-96 rounded-lg border border-border bg-popover-84 p-2 shadow-lg" accessibilityLabel="Edit citation comment" testID="Citation comment editor">
        <Input
          value={comment()}
          multiline
          autoFocus
          submitBehavior="submit"
          placeholder="Add an optional comment..."
          accessibilityLabel="Comment on selected text"
          accessibilityHint="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
          onChange={(event) => update(event.value)}
          onSubmit={() => submit(false)}
          onKeyPress={(event) => { if (event.key === "Escape") settle("escape-key"); }}
          class="max-h-40 min-h-16 w-full bg-transparent px-1 py-1.5 text-sm text-foreground"
        />
        {tooLong() ? <Text class="pt-1 text-xs text-error-foreground">{`Comments can contain up to ${ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()} characters.`}</Text> : null}
        <View class="mt-2 flex-row flex-wrap items-center justify-end gap-2">
          <View class="h-6 items-center justify-center rounded-md border border-input px-2 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" role="button" accessibilityLabel="Cancel" onPress={close}>
            <Text class="text-xs text-foreground">Cancel</Text>
          </View>
          <View class={`h-6 items-center justify-center rounded-md bg-primary px-2 ${tooLong() ? "opacity-64" : "active:scale-[0.97] transition-transform duration-150 ease-in-out"}`} role="button" disabled={tooLong()} accessibilityLabel={tooLong() ? "Shorten comment" : "Save"} onPress={() => submit(false)}>
            <Text class="text-xs text-primary-foreground">{tooLong() ? "Shorten comment" : "Save"}</Text>
          </View>
        </View>
      </View>
    </Overlay>
  );
}

/** The editor of the citation the composer has open (after Cite, or from a chip's pencil). */
export function CitationCommentEditorHost(props: { onSubmitAndSend?: () => void; chipRef?: (source: string) => ViewRef | undefined; onRestoreFocus?: () => void }) {
  return (
    <If when={citationCommentEditor()}>
      {(state) => {
        const anchor = state().anchor ?? props.chipRef?.(state().source) ?? null;
        return anchor ? <AssistantCitationCommentEditor anchor={anchor} citation={state().citation} source={state().source} onSubmitAndSend={props.onSubmitAndSend} onRestoreFocus={props.onRestoreFocus} /> : null;
      }}
    </If>
  );
}

/** AssistantCitationChip, composer variant: the quote link ("View cited assistant text") and the comment pencil. */
export function ComposerCitationChips(props: { draft: () => string; chipRefs: Map<string, ViewRef> }) {
  const citations = () => collectAssistantCitations(props.draft());
  return citations().length > 0 ? (
    <View class="flex-row flex-wrap items-center gap-1.5 pb-2" accessibilityLabel="Cited assistant text">
      <Each of={citations()} key={(entry) => entry.source}>
        {(entry) => {
          const label = () => assistantCitationLabel(entry().citation);
          return (
            <View ref={(node) => { if (node) props.chipRefs.set(entry().source, node); }} class="h-6 max-w-80 flex-row items-center gap-0.5 rounded-md border border-border bg-muted-10 ps-1.5 pe-0.5" testID="Composer citation chip">
              <View class="min-w-0 flex-row items-center gap-1 rounded-sm" role="link" accessibilityLabel={`View cited assistant text: ${label()}`} onPress={() => goToCitationSource(entry().citation)}>
                <TimelineIcon name="quote" size={12} tint={chipColor("citation") ?? undefined} />
                <Text class="min-w-0 max-w-64 truncate text-xs font-medium" style={{ color: chipColor("citation") ?? undefined }}>{label()}</Text>
              </View>
              <View
                class="size-5 items-center justify-center rounded-sm hover:bg-accent transition-colors duration-150 ease-in-out"
                role="button"
                accessibilityLabel={entry().citation.comment ? "Edit citation comment" : "Add comment to citation"}
                onPress={() => openCitationCommentEditor(entry().citation, null, true)}
              >
                <TimelineIcon name="pencil" size={12} />
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  ) : null;
}

