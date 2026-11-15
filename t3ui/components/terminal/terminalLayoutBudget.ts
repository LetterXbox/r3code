// resolveTerminalDrawerMaxHeight (ThreadTerminalDrawer.tsx): the composer takes its room before the drawer does, so a tall
// drawer cannot push it into the header. ThreadView reports the chat column's height (below the header) and the composer lane's.
import { signal } from "nsh";

export const chatColumnHeight = signal(0);
export const composerLaneHeight = signal(0);

/** What the drawer may use of the chat column, or undefined while the column has not been measured. */
export function drawerHeightBudget(column = chatColumnHeight(), composer = composerLaneHeight()): number | undefined {
  return column > 0 ? Math.max(0, column - composer) : undefined;
}
