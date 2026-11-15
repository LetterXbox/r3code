// ComposerPendingUserInputPanel.tsx: a collapsible banner for the active question, with an
// n/m count, digit shortcuts, auto-advance after a single choice, and the Previous / Next /
// Submit actions that the web keeps in ComposerPrimaryActions.
import { computed, effect, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { chatWidthClass } from "./layout";
import { ChatMarkdown } from "./markdown/ChatMarkdown";
import { TimelineIcon } from "./markdown/TimelineIcon";
import type { PendingUserInput, UserInputQuestion } from "../../store";
import { composerDraft, setActiveUserInputQuestion, setComposerDraft } from "../../store";
import { showToast } from "../toast/toastState";
import { carryDisplacedCustomAnswerIntoPrompt } from "./userInputFlow";
import { setComposerQuestionControls } from "./userInputControls";
import { composerGlassSurface, composerOutline } from "../composer/tokenColor";
import {
  deriveProgress, isCompactPrimaryActions, optionForDigit, optionSelected, primaryLabel, resolveAnswer, toggleSelection, withCustomAnswer,
  type Answer, type DraftAnswer,
} from "./userInputFlow";

export type InputQuestion = UserInputQuestion;
export type UserInputDisplay = PendingUserInput;
export { resolveAnswer };

const AUTO_ADVANCE_MS = 200;

const drafts = signal<Record<string, Record<string, DraftAnswer>>>({});
const questionIndexes = signal<Record<string, number>>({});
const collapsedQuestions = signal<Record<string, string>>({});
const busy = signal<Record<string, boolean>>({});
const errors = signal<Record<string, string>>({});
// The footer row's width: under 780 pt the pending-answer actions go compact (composerFooterLayout.ts).
const footerWidth = signal<number | null>(null);
const compactActions = () => isCompactPrimaryActions(footerWidth());

function Kbd(props: { label: string }) {
  return (
    <View class="h-5 min-w-5 items-center justify-center rounded border border-border-60 px-1">
      <Text class="text-2xs font-medium tabular-nums text-muted-foreground">{props.label}</Text>
    </View>
  );
}

/** Drawn like ui/radio-group: a ring, with a primary disc and a dot while checked. */
function OptionRadio(props: { checked: boolean }) {
  return (
    <View class="size-4 items-center justify-center rounded-full border border-input bg-background">
      {props.checked ? (
        <View class="absolute -inset-px items-center justify-center rounded-full bg-primary">
          <View class="size-1.5 rounded-full bg-primary-foreground" />
        </View>
      ) : null}
    </View>
  );
}

function OptionCheckbox(props: { checked: boolean }) {
  return (
    <View class={props.checked ? "size-4 items-center justify-center rounded border border-primary bg-primary" : "size-4 items-center justify-center rounded border border-input bg-background"}>
      {props.checked ? <TimelineIcon name="check" size={12} tint="#ffffff" /> : null}
    </View>
  );
}

export function UserInputPanel(props: {
  scope: () => string;
  threadId?: () => string;
  integrated?: boolean;
  requests: () => PendingUserInput[];
  /** `activeQuestionId`: the question open at submit, which the composer's attachments go with. */
  onRespond: (id: string, answers: Record<string, Answer>, activeQuestionId?: string) => Promise<void>;
  /** Dismiss a message-mode question without answering it (thread.user-input.dismiss). */
  onDismiss?: (id: string) => Promise<void>;
}) {
  const key = (requestId: string) => `${props.scope()}\0${requestId}`;
  // Like the web, only the oldest request is asked at a time.
  const requestNow = computed(() => props.requests()[0]);
  const request = () => requestNow();
  const requestDrafts = (): Record<string, DraftAnswer> => { const current = request(); return current ? drafts()[key(current.id)] ?? {} : {}; };
  const progress = () => deriveProgress(request()?.questions ?? [], requestDrafts(), questionIndexes()[key(request()?.id ?? "")] ?? 0);
  const respondingNow = computed(() => Boolean(busy()[key(request()?.id ?? "")]));
  const responding = () => respondingNow();
  const activeQuestion = computed(() => progress().activeQuestion);
  const collapsedNow = computed(() => { const active = activeQuestion(); return active !== null && collapsedQuestions()[key(request()?.id ?? "")] === active.id; });
  const collapsed = () => collapsedNow();
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;
  const clearAdvance = () => { clearTimeout(advanceTimer); advanceTimer = undefined; };

  function writeDraft(requestId: string, questionId: string, value: DraftAnswer) {
    const stateKey = key(requestId);
    drafts.update((all) => ({ ...all, [stateKey]: { ...all[stateKey], [questionId]: value } }));
  }
  function setIndex(requestId: string, index: number) {
    questionIndexes.update((all) => ({ ...all, [key(requestId)]: Math.max(0, index) }));
  }
  function buildAnswers(current: PendingUserInput): Record<string, Answer> | null {
    const answers: Record<string, Answer> = {};
    for (const question of current.questions) {
      const answer = resolveAnswer(question, drafts()[key(current.id)]?.[question.id]);
      if (answer === null) return null;
      answers[question.id] = answer;
    }
    return answers;
  }
  async function submit(current: PendingUserInput) {
    const answers = buildAnswers(current);
    const stateKey = key(current.id);
    if (!answers || busy()[stateKey]) return;
    busy.update((all) => ({ ...all, [stateKey]: true }));
    errors.update((all) => ({ ...all, [stateKey]: "" }));
    try {
      await props.onRespond(current.id, answers, progress().activeQuestion?.id);
      const without = <T,>(all: Record<string, T>) => { const { [stateKey]: _removed, ...rest } = all; return rest; };
      drafts.update(without);
      questionIndexes.update(without);
      collapsedQuestions.update(without);
    } catch (error) {
      errors.update((all) => ({ ...all, [stateKey]: error instanceof Error ? error.message : String(error) }));
      busy.update((all) => ({ ...all, [stateKey]: false }));
    }
  }
  async function dismiss(current: PendingUserInput) {
    const stateKey = key(current.id);
    if (!props.onDismiss || busy()[stateKey]) return;
    busy.update((all) => ({ ...all, [stateKey]: true }));
    errors.update((all) => ({ ...all, [stateKey]: "" }));
    try {
      await props.onDismiss(current.id);
    } catch (error) {
      errors.update((all) => ({ ...all, [stateKey]: error instanceof Error ? error.message : String(error) }));
    }
    busy.update((all) => ({ ...all, [stateKey]: false }));
  }
  /** onAdvanceActivePendingUserInput: the last question submits, an earlier one moves on once answered. */
  function advance() {
    const current = request();
    const state = progress();
    if (!current || responding()) return;
    if (state.isLastQuestion) { if (state.isComplete) void submit(current); return; }
    if (state.canAdvance) setIndex(current.id, state.questionIndex + 1);
  }
  function choose(value: string) {
    const current = request();
    const question = progress().activeQuestion;
    if (!current || !question || responding()) return;
    // The option replaces the custom answer; what was typed there is the user's text, so it goes back to the draft.
    const currentPrompt = composerDraft();
    const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(currentPrompt, requestDrafts()[question.id]?.customAnswer);
    if (nextPrompt !== currentPrompt) {
      setComposerDraft(nextPrompt);
      showToast({ type: "info", title: "Your typed text was set aside", description: "It will be back in the composer once the question is answered." });
    }
    writeDraft(current.id, question.id, toggleSelection(question, requestDrafts()[question.id], value));
    if (question.multiSelect) return;
    clearAdvance();
    advanceTimer = setTimeout(() => { advanceTimer = undefined; advance(); }, AUTO_ADVANCE_MS);
  }
  const digits = Object.fromEntries(["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => [digit, () => {
    if (!request() || collapsed() || responding()) return;
    const value = optionForDigit(progress().activeQuestion, digit);
    if (value !== null) choose(value);
  }]));
  // Digits type into inputs, so the shortcuts only fire while none has the focus.
  keymap.bind(digits);
  effect(() => {
    request()?.id;
    progress().questionIndex;
    return clearAdvance;
  });
  // questionAttachments.ts: the composer's attachments belong to the open question (each question keeps its own).
  effect(() => {
    const scope = props.scope();
    const current = request();
    const question = activeQuestion();
    setActiveUserInputQuestion(props.threadId?.() || scope, current && question ? { requestId: current.id, questionId: question.id, allowCustomAnswer: question.allowCustomAnswer, responding: responding() } : null);
  });
  effect(() => { const scope = props.threadId?.() || props.scope(); return () => setActiveUserInputQuestion(scope, null); });
  effect(() => {
    if (!props.integrated) return;
    const scope = props.scope();
    const current = request();
    const state = progress();
    const question = state.activeQuestion;
    const isResponding = responding();
    const draft = question ? requestDrafts()[question.id] : undefined;
    untracked(() => setComposerQuestionControls(scope, current && question ? {
      text: draft?.customAnswer ?? question.initialAnswer ?? "",
      allowCustomAnswer: question.allowCustomAnswer !== false,
      isLast: state.isLastQuestion,
      canAdvance: state.isLastQuestion ? state.isComplete : state.canAdvance,
      canGoBack: state.questionIndex > 0,
      responding: isResponding,
      setText: (text) => writeDraft(current.id, question.id, withCustomAnswer(question, requestDrafts()[question.id], text)),
      advance,
      previous: () => setIndex(current.id, state.questionIndex - 1),
    } : null));
  });
  effect(() => { if (!props.integrated) return; const scope = props.scope(); return () => setComposerQuestionControls(scope, null); });

  return (
    <If when={requestNow()}>
      {(current) => (
        <View class={props.integrated ? `mx-auto w-full ${chatWidthClass()}` : `mx-auto w-full px-3 pb-2 ${chatWidthClass()}`} style={props.integrated ? { paddingLeft: 22, paddingRight: 22, marginBottom: -16 } : undefined}>
          <View class="rounded-2xl border border-border-60 bg-card-40" style={props.integrated ? { paddingBottom: 16, backgroundColor: composerGlassSurface(), borderColor: composerOutline() } : undefined} accessibilityLabel="Pending question">
            <If when={activeQuestion()}>
              {(question) => (
                <>
                  <View
                    class="min-h-7 flex-row items-center gap-1 rounded-xl px-4 pt-1.5 hover:bg-accent"
                    onPress={() => collapsedQuestions.update((all) => {
                      const stateKey = key(current().id);
                      if (all[stateKey] === question().id) { const { [stateKey]: _removed, ...rest } = all; return rest; }
                      return { ...all, [stateKey]: question().id };
                    })}
                    accessibilityLabel={collapsed() ? "Show the question and its options" : "Hide the question and its options"}
                    accessibilityState={{ expanded: !collapsed() }}
                    role="button"
                  >
                    <View class="min-w-0 flex-1 flex-row items-center gap-1">
                      <Text class={collapsed() ? "max-w-[50%] truncate text-xs text-muted-foreground" : "min-w-0 truncate text-xs text-muted-foreground"}>{question().header}</Text>
                      {collapsed() ? (
                        <>
                          <Text class="text-xs text-muted-foreground">·</Text>
                          <Text class="min-w-0 flex-1 truncate text-xs text-secondary-label">{question().question}</Text>
                        </>
                      ) : null}
                    </View>
                    {current().questions.length > 1 ? (
                      <Text class="min-w-6 text-center text-xs font-medium tabular-nums text-muted-foreground">{`${progress().questionIndex + 1}/${current().questions.length}`}</Text>
                    ) : null}
                    <View class="size-6 items-center justify-center">
                      <TimelineIcon name={collapsed() ? "chevron-up" : "chevron-down"} size={14} />
                    </View>
                    {current().dismissible && props.onDismiss ? (
                      <View
                        class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                        onPress={() => void dismiss(current())}
                        disabled={responding()}
                        tooltip="Dismiss question without answering"
                        accessibilityLabel="Dismiss question without answering"
                        role="button"
                      >
                        <TimelineIcon name="x" size={14} />
                      </View>
                    ) : null}
                  </View>
                  {!collapsed() ? (
                    <Scroll class="max-h-96" contentClass="pb-1 ps-5 pe-4">
                      <View selectable class="pt-2">
                        <ChatMarkdown text={() => question().question} class="text-foreground" />
                      </View>
                      <View class="-ms-1.5 mt-1.5">
                        <Each of={question().options} key={(option) => option.value ?? option.label}>
                          {(option, index) => {
                            const value = () => option().value ?? option().label;
                            const selected = () => optionSelected(progress(), value());
                            return (
                              <View
                                class={responding() ? "flex-row items-start gap-2.5 rounded-md py-1.5 ps-1.5 opacity-50" : "flex-row items-start gap-2.5 rounded-md py-1.5 ps-1.5 hover:bg-muted-30 transition-colors duration-150 ease-in-out"}
                                onPress={() => choose(value())}
                                disabled={responding()}
                                accessibilityLabel={option().label}
                                accessibilityState={{ checked: selected() }}
                                role={question().multiSelect ? "checkbox" : "radio"}
                              >
                                <View class="h-5 justify-center">
                                  {question().multiSelect ? <OptionCheckbox checked={selected()} /> : <OptionRadio checked={selected()} />}
                                </View>
                                <View class="min-w-0 flex-1 gap-0.5">
                                  <Text class={selected() ? "text-sm font-medium text-foreground" : "text-sm font-medium text-foreground opacity-70"}>{option().label}</Text>
                                  {option().description && option().description !== option().label ? <Text class="text-2xs text-secondary-label">{option().description}</Text> : null}
                                </View>
                                {index() < 9 ? <View class="h-5 w-6 items-center justify-center"><Kbd label={String(index() + 1)} /></View> : null}
                              </View>
                            );
                          }}
                        </Each>
                      </View>
                      {!props.integrated && question().allowCustomAnswer !== false ? (
                        <View class="pb-1 pt-2">
                          <Input
                            value={requestDrafts()[question().id]?.customAnswer ?? question().initialAnswer ?? ""}
                            placeholder={question().options.length > 0 ? "Type your own answer, or leave this blank to use the selected option" : "Type your answer"}
                            accessibilityLabel={`Answer ${question().header}`}
                            readonly={responding()}
                            onChange={(event) => writeDraft(current().id, question().id, withCustomAnswer(question(), requestDrafts()[question().id], event.value))}
                            class="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
                          />
                        </View>
                      ) : null}
                    </Scroll>
                  ) : null}
                  {errors()[key(current().id)] ? <Text class="px-4 pb-1 text-xs text-error-foreground">{errors()[key(current().id)]}</Text> : null}
                  {!props.integrated ? <View class={compactActions() ? "flex-row items-center justify-end gap-1.5 px-3 pb-2 pt-1" : "flex-row items-center justify-end gap-2 px-3 pb-2 pt-1"} onLayout={(event: { bounds: { size: { width: number } } }) => footerWidth.set(event.bounds.size.width)}>
                    {progress().questionIndex > 0 ? (
                      <View
                        class={compactActions()
                          ? "size-7 items-center justify-center rounded-lg border border-input hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                          : "h-8 items-center justify-center rounded-lg border border-input px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"}
                        onPress={() => setIndex(current().id, progress().questionIndex - 1)}
                        disabled={responding()}
                        accessibilityLabel="Previous question"
                        role="button"
                      >
                        {compactActions() ? <TimelineIcon name="chevron-left" size={14} /> : <Text class="text-sm text-foreground">Previous</Text>}
                      </View>
                    ) : null}
                    <View
                      class={compactActions() ? "h-8 items-center justify-center rounded-full bg-message-action px-3" : "h-8 items-center justify-center rounded-full bg-message-action px-4"}
                      onPress={advance}
                      disabled={responding() || (progress().isLastQuestion ? !progress().isComplete : !progress().canAdvance)}
                      accessibilityLabel={primaryLabel(progress(), false)}
                      role="button"
                    >
                      <Text class="text-sm font-medium text-message-action-foreground">{primaryLabel(progress(), responding(), compactActions())}</Text>
                    </View>
                  </View> : null}
                </>
              )}
            </If>
          </View>
        </View>
      )}
    </If>
  );
}
