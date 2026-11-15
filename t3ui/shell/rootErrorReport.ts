// routes/__root.tsx: the error report of the root error view (errorMessage, errorDetails, errorReport).
const MAX_ERROR_CAUSE_DEPTH = 5;

export function rootErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    // Some engines' stacks start at the first frame, without the error's own line.
    const head = `${error.name}: ${error.message}`;
    return error.stack ? (error.stack.includes(error.message) ? error.stack : `${head}\n${error.stack}`) : head;
  }
  if (typeof error === "string") return error;
  try { return JSON.stringify(error, null, 2); } catch { return "No additional error details are available."; }
}

/** The copyable report: the app and version, where, when, then the error and its causes. */
export function rootErrorReport(error: unknown, input: { appName: string; version: string; path: string; now?: Date }): string {
  const lines = [`${input.appName} ${input.version}`, `Path: ${input.path}`, `Time: ${(input.now ?? new Date()).toISOString()}`, "", errorDetails(error)];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}
