// state/terminal.ts attach: `resume: true` only after the server answered an attach of this session; an unanswered
// first attach is retried unchanged on the next session (with its restartIfNotRunning, when it was a restart).

const answered = new Set<string>();
const unansweredRestarts = new Set<string>();

/** The resume flags of the next terminal.attach for `sessionKey`. */
export function attachResumeFlags(sessionKey: string, explicitRestart: boolean): { resume: boolean; restartIfNotRunning: boolean } {
  if (explicitRestart) unansweredRestarts.add(sessionKey);
  const restartIfNotRunning = unansweredRestarts.has(sessionKey);
  return { resume: !restartIfNotRunning && answered.has(sessionKey), restartIfNotRunning };
}

/** The server answered an attach of `sessionKey` (a snapshot or restarted event). */
export function noteAttachAnswered(sessionKey: string) {
  answered.add(sessionKey);
  unansweredRestarts.delete(sessionKey);
}
