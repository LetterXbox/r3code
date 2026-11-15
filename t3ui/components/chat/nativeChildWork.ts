// chat/NativeChildWorkDialog.tsx's data: `orchestration.getNativeChildWork` (OrchestrationV2GetNativeChildWorkResult) read
// while the dialog is open, and its step labels.
export interface NativeChildStep { index: number; type: string; status: string | null; text: string | null; toolCalls: { name: string; input: string }[] }
export interface NativeChildWork { conversationId: string; role: string; prompt: string; steps: NativeChildStep[] | null; truncated: boolean }

const rec = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null);
const str = (value: unknown) => (typeof value === "string" ? value : null);

/** stepLabel: "TOOL_CALL" reads "Tool call". */
export function stepLabel(type: string): string {
  const words = type.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The step's header: its type, and its status unless it is DONE. */
export function stepHeading(step: NativeChildStep): string {
  return `${stepLabel(step.type)}${step.status !== null && step.status !== "DONE" ? ` · ${stepLabel(step.status)}` : ""}`;
}

export function readNativeChildWork(value: unknown): NativeChildWork[] | null {
  const children = rec(value)?.children;
  if (!Array.isArray(children)) return null;
  return children.flatMap((entry) => {
    const child = rec(entry);
    const conversationId = str(child?.conversationId);
    if (!child || !conversationId) return [];
    const steps = Array.isArray(child.steps) ? child.steps.flatMap((raw) => {
      const step = rec(raw);
      if (!step || typeof step.index !== "number" || typeof step.type !== "string") return [];
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls.flatMap((call) => { const c = rec(call); return c && typeof c.name === "string" && typeof c.input === "string" ? [{ name: c.name, input: c.input }] : []; }) : [];
      return [{ index: step.index, type: step.type, status: str(step.status), text: str(step.text), toolCalls }];
    }) : null;
    return [{ conversationId, role: str(child.role) ?? "", prompt: str(child.prompt) ?? "", steps, truncated: child.truncated === true }];
  });
}
