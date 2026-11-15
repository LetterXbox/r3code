// What the composer's keyboard shortcuts open. The controls (permissions menu, branch picker,
// workspace menu) live in separate components; a command sets one of these and the control reacts,
// the way the web's `data-composer-shortcut` lookup clicks the control a command names
// (chat/composerShortcuts.ts, ChatComposer.tsx).
import { signal } from "nsh";

/** composer.mode: Permissions live in the model picker's footer, and in a chip while the mode differs from the default. */
export type PermissionsSlot = "chip" | "footer";
const permissions = signal<PermissionsSlot | null>(null);
export const permissionsOpenIn = () => permissions();
export function setPermissionsOpen(slot: PermissionsSlot, open: boolean) {
  if (open) permissions.set(slot);
  else if (permissions() === slot) permissions.set(null);
}
export function closePermissionsMenu() { permissions.set(null); }

/** composer.branch. */
export const branchPickerOpen = signal(false);

/** composer.workspace / composer.previousWorktree: a counter the workspace control watches. */
const workspaceRequest = signal(0);
export const workspaceMenuRequests = () => workspaceRequest();
export function requestWorkspaceMenu() { workspaceRequest.update((n) => n + 1); }

const previousWorktreeRequest = signal(0);
export const previousWorktreeRequests = () => previousWorktreeRequest();
export function requestPreviousWorktree() { previousWorktreeRequest.update((n) => n + 1); }

/** composer.effort opens the model picker; the effort column is docked in it. */
export const modelPickerOpen = signal(false);

/** composer.host: a counter the "Run on" control watches. */
const hostRequest = signal(0);
export const hostMenuRequests = () => hostRequest();
export function requestHostMenu() { hostRequest.update((n) => n + 1); }

/** composer.effort marks the picker it opens (markOpenToEffort): once the popup is open its docked effort column takes the focus. */
export const effortFocusPending = signal(false);
