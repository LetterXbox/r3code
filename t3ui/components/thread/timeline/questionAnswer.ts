// packages/client-runtime/src/work-log/userInput.ts: an answered user_input_request's question and answer previews.
type Rec = Record<string, unknown>;
const record = (value: unknown): Rec | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);

export interface QuestionAnswer { questionTextById?: Record<string, string>; answers: Record<string, unknown>; attachmentsByQuestionId: Record<string, { id?: string; name: string; type?: string }[]> }

export function readQuestionAnswer(value: unknown): QuestionAnswer | undefined {
  const answer = record(value);
  if (!answer) return undefined;
  const texts = record(answer.questionTextById);
  const attachments = record(answer.attachmentsByQuestionId) ?? {};
  return {
    ...(texts ? { questionTextById: Object.fromEntries(Object.entries(texts).filter(([, text]) => typeof text === "string")) as Record<string, string> } : {}),
    answers: record(answer.answers) ?? {},
    attachmentsByQuestionId: Object.fromEntries(Object.entries(attachments).map(([id, list]) => [id, Array.isArray(list) ? list.map(record).filter((item): item is Rec => !!item && typeof item.name === "string") as never : []])),
  };
}

export function getQuestionAnswerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(getQuestionAnswerText).filter(Boolean).join(", ");
  const nested = record(value);
  return nested ? getQuestionAnswerText(nested.answers) : "";
}

export function getQuestionTextPreview(answer: QuestionAnswer): string {
  return Object.values(answer.questionTextById ?? {}).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ");
}

export function getQuestionAnswerPreview(answer: QuestionAnswer): string {
  const answers = Object.values(answer.answers).map(getQuestionAnswerText).filter(Boolean);
  const attachments = Object.values(answer.attachmentsByQuestionId).flat().map((attachment) => attachment.name);
  return (answers.length > 0 ? answers.join(" · ") : attachments.length > 0 ? attachments.join(", ") : Object.values(answer.questionTextById ?? {}).join(" · ")).replace(/\s+/g, " ").trim();
}

export function hasQuestionAnswer(answer: QuestionAnswer): boolean {
  return Object.values(answer.answers).some(getQuestionAnswerText) || Object.values(answer.attachmentsByQuestionId).some((list) => list.length > 0);
}

/** QuestionAnswerHistory as text: each question, its answer indented, and its attachment names. */
export function questionAnswerHistory(answer: QuestionAnswer): string {
  const ids = [...new Set([...Object.keys(answer.questionTextById ?? {}), ...Object.keys(answer.answers), ...Object.keys(answer.attachmentsByQuestionId)])];
  return ids.map((id) => {
    const lines: string[] = [];
    const question = answer.questionTextById?.[id];
    if (question) lines.push(question);
    const text = getQuestionAnswerText(answer.answers[id]);
    if (text) lines.push(`  ${text}`);
    const files = (answer.attachmentsByQuestionId[id] ?? []).map((attachment) => attachment.name);
    if (files.length) lines.push(`  ${files.join(", ")}`);
    return lines.join("\n");
  }).filter(Boolean).join("\n\n");
}
