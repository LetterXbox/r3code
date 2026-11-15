// What ChatView / ChatComposer hold for citations: the Go to source request a citation link makes
// (assistantCitationNavigation: a fresh activation each time), and the comment editor of a citation in the composer
// (ComposerCitationCommentContext / requestCitationComment).
import { signal } from "nsh";
import { composerDraft, openThreadById, setComposerDraft, threadById } from "../../../store";
import { showToast } from "../../toast";
import { placeContextReference } from "../../composer/terminalContext";
import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, collectAssistantCitations, serializeAssistantCitation, withAssistantCitationComment, type AssistantCitation } from "../markdown/assistantCitations";
import type { HostRect } from "./hostSelection";

export interface AssistantCitationRequest { citation: AssistantCitation; key: string }

/** The citation whose source the timeline is revealing. */
export const citationRequest = signal<AssistantCitationRequest | null>(null);
let activations = 0;

/** assistantCitationNavigation: opens the cited thread with a fresh activation of the citation. */
export function goToCitationSource(citation: AssistantCitation): boolean {
  if (!threadById(citation.threadId)) {
    showToast({ type: "warning", title: "The cited response is unavailable", description: "It may have been removed. The selected text is still saved in your citation." });
    return false;
  }
  activations += 1;
  citationRequest.set({ citation, key: `${serializeAssistantCitation(citation)}#${activations}` });
  openThreadById(citation.threadId);
  return true;
}

export function retireCitationRequest(key: string) {
  if (citationRequest()?.key === key) citationRequest.set(null);
}

export interface CitationCommentEditorState {
  /** The citation link in the composer the editor edits. */
  source: string;
  citation: AssistantCitation;
  /** The cited text's last line (window points) while it is on screen: the editor opens below it. */
  anchor: HostRect | null;
  /** The chip's pencil it opened from, when not from the source. */
  fromChip: boolean;
  key: number;
}

export const citationCommentEditor = signal<CitationCommentEditorState | null>(null);
let editorKeys = 0;

export function openCitationCommentEditor(citation: AssistantCitation, anchor: HostRect | null, fromChip: boolean) {
  editorKeys += 1;
  citationCommentEditor.set({ source: serializeAssistantCitation(citation), citation, anchor, fromChip, key: editorKeys });
}

export const closeCitationCommentEditor = () => citationCommentEditor.set(null);

/** citeAssistantText: the citation goes in at the composer's caret (a space before it unless one is there), then its comment editor opens. */
export function citeAssistantText(citation: AssistantCitation, anchor: HostRect | null): boolean {
  placeContextReference(serializeAssistantCitation(citation));
  openCitationCommentEditor(citation, anchor, false);
  return true;
}

/** Saves `comment` into the citation link `source` of the composer's prompt; false when the link is gone or the comment too long. */
export function saveCitationComment(source: string, comment: string): boolean {
  if (comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) return false;
  const draft = composerDraft();
  const match = collectAssistantCitations(draft).find((entry) => entry.source === source);
  if (!match) return false;
  const next = serializeAssistantCitation(withAssistantCitationComment(match.citation, comment));
  setComposerDraft(draft.slice(0, match.start) + next + draft.slice(match.end));
  const open = citationCommentEditor();
  if (open?.source === source) citationCommentEditor.set({ ...open, source: next, citation: withAssistantCitationComment(match.citation, comment) });
  return true;
}
