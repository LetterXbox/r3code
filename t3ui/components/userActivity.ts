// When the user last did something the UI must answer at once (typed, scrolled, moved the pointer). The host reports no
// global input events, so the places that see input note it here; idle-time work (Shiki grammar builds) waits for quiet.
// Startup counts as activity: the app is still settling and the user is about to act.
let lastInputAt = Date.now();

export function noteUserInput(): void {
  lastInputAt = Date.now();
}

/** Milliseconds since the last noted input. */
export function msSinceUserInput(now = Date.now()): number {
  return now - lastInputAt;
}
