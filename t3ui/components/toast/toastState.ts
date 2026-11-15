// The app's toasts (components/ui/toast.tsx's toastManager and stackedThreadToast in the web app): a title, an optional
// description, up to three action buttons, an optional id that replaces the toast with that id, and a timeout
// (loading toasts stay until closed, as the clone progress toast does). The host paints them (ToastHost.tsx); any module
// raises one with `showToast`.
import { signal } from "nsh";

export type ToastType = "success" | "error" | "warning" | "info" | "loading";
export type ToastActionVariant = "default" | "outline" | "destructive" | "destructive-outline" | "ghost" | "secondary";
export interface ToastAction { label: string; run: () => void; variant?: ToastActionVariant; /** Shown dimmed and takes no press (the keybindings warning's Open button without an editor). */ disabled?: boolean }
/** The mark a toast draws in place of its type's (the web's `data.leadingIcon`): thread notifications pick one by status. */
export type ToastLeadingIcon = "circle-check" | "circle-alert" | "shield-question" | "message-circle-question" | "star" | "download";
export type ToastLeadingTone = "success" | "warning" | "destructive" | "info";
/** The web's `data.expandableContent`: rows hidden behind a "Show ..." trigger under the description (the slow requests toast). */
export interface ToastExpandable { labels: { expand: string; collapse: string }; rows: { title: string; detail: string }[] }
export interface ToastItem {
  id: string;
  /** Absent for a plain notice (the appearance cycle's "Appearance: Dark"): no icon. */
  type: ToastType | undefined;
  title: string;
  description?: string;
  actions: ToastAction[];
  /** Runs when the toast is dismissed by its close button (not when an action closes it). */
  onClose?: () => void;
  /** An error's description gets a copy button unless this is set. */
  hideCopyButton?: boolean;
  leadingIcon?: { name: ToastLeadingIcon; tone: ToastLeadingTone };
  expandable?: ToastExpandable;
  /** The thread the toast belongs to (the web's `data.threadRef`): it shows only while that thread is the open one. */
  threadRef?: ToastThreadRef;
  /** The web's `data.actionLayout`; see ToastInput. */
  actionLayout?: ToastActionLayout;
}
/** ui/toast.tsx `actionLayout`: "stacked-end" puts the buttons on their own row under the text (stackedThreadToast),
 * "inline" keeps them at the end of the text's row (toastManager.add, the thread notification). */
export type ToastActionLayout = "inline" | "stacked-end";
/** `ScopedThreadRef`: the environment is compared only when both sides know it. */
export interface ToastThreadRef { threadId: string; environmentId?: string }
export interface ToastInput {
  /** A toast with this id replaces the one already showing under it (an update in place, restarting its timeout). */
  id?: string;
  type?: ToastType;
  title: string;
  description?: string;
  /** The buttons, in display order: the primary action last, as the web's secondary / primary pair. */
  actions?: ToastAction[];
  /** Milliseconds until it closes itself; 0 keeps it until closed. Default 5000, none for loading. */
  timeoutMs?: number;
  onClose?: () => void;
  hideCopyButton?: boolean;
  leadingIcon?: { name: ToastLeadingIcon; tone: ToastLeadingTone };
  expandable?: ToastExpandable;
  /** Shows the toast only on this thread (the web's `data.threadRef`); absent shows it everywhere. */
  threadRef?: ToastThreadRef;
  /** Where the action buttons go. Default "stacked-end" (most of the web's toasts with an action come from
   * stackedThreadToast). A toast without an action always lays out inline, as the web's does. */
  actionLayout?: ToastActionLayout;
}

export const DEFAULT_TOAST_TIMEOUT_MS = 5000;
/** How many toasts the stack shows at once (Base UI's default `limit`); older ones wait behind. */
export const TOAST_LIMIT = 3;

const items = signal<ToastItem[]>([]);
/** True while the pointer rests on the stack: timers are held and the stack opens out. */
export const toastsHovered = signal(false);

interface Timer { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }
const timers = new Map<string, Timer>();
let counter = 0;

/** Newest first, as the stack shows them. */
export const toasts = () => items();

function timeoutFor(input: { timeoutMs?: number; type?: ToastType | undefined }): number {
  return input.timeoutMs ?? (input.type === "loading" ? 0 : DEFAULT_TOAST_TIMEOUT_MS);
}

function stop(id: string) {
  const timer = timers.get(id);
  if (timer?.handle != null) clearTimeout(timer.handle);
  timers.delete(id);
}

function start(id: string, ms: number) {
  stop(id);
  if (ms <= 0) return;
  const timer: Timer = { handle: null, remaining: ms, startedAt: Date.now() };
  timer.handle = setTimeout(() => closeToast(id), ms);
  timers.set(id, timer);
}

/** Holds every timer while the pointer is on the stack, and runs the rest of each when it leaves. */
export function setToastsHovered(hovered: boolean) {
  if (toastsHovered() === hovered) return;
  toastsHovered.set(hovered);
  for (const [id, timer] of timers) {
    if (hovered) {
      if (timer.handle != null) clearTimeout(timer.handle);
      timer.handle = null;
      timer.remaining = Math.max(1, timer.remaining - (Date.now() - timer.startedAt));
    } else {
      timer.startedAt = Date.now();
      timer.handle = setTimeout(() => closeToast(id), timer.remaining);
    }
  }
}

function build(id: string, input: ToastInput): ToastItem {
  const item: ToastItem = { id, type: input.type, title: input.title, actions: input.actions ?? [] };
  if (input.description) item.description = input.description;
  if (input.onClose) item.onClose = input.onClose;
  if (input.hideCopyButton) item.hideCopyButton = true;
  if (input.leadingIcon) item.leadingIcon = input.leadingIcon;
  if (input.expandable) item.expandable = input.expandable;
  if (input.threadRef) item.threadRef = input.threadRef;
  if (input.actionLayout) item.actionLayout = input.actionLayout;
  return item;
}

/** Raises a toast and returns its id. */
export function showToast(input: ToastInput): string {
  const id = input.id ?? `toast:${++counter}`;
  const item = build(id, input);
  const existing = items().some((candidate) => candidate.id === id);
  // A toast raised under an id that is showing replaces it where it stands; a new one goes in front.
  items.update((all) => existing ? all.map((candidate) => (candidate.id === id ? item : candidate)) : [item, ...all]);
  if (toastsHovered()) {
    // Held like the rest: it runs its timeout once the pointer leaves.
    stop(id);
    const ms = timeoutFor(input);
    if (ms > 0) timers.set(id, { handle: null, remaining: ms, startedAt: Date.now() });
  } else start(id, timeoutFor(input));
  return id;
}

export const addToast = showToast;

export function updateToast(id: string, input: ToastInput) {
  if (!items().some((candidate) => candidate.id === id)) return;
  showToast({ ...input, id });
}

export function closeToast(id: string) {
  stop(id);
  items.update((all) => all.filter((item) => item.id !== id));
  if (items().length === 0) toastsHovered.set(false);
}

/** The close button: runs the toast's own `onClose` first. */
export function dismissToast(id: string) {
  const item = items().find((candidate) => candidate.id === id);
  item?.onClose?.();
  closeToast(id);
}

export function clearToasts() {
  for (const id of [...timers.keys()]) stop(id);
  items.set([]);
  toastsHovered.set(false);
}

/** stackedThreadToast: an error with the title the web shows and the reason below it. */
export function errorToast(title: string, description?: string, options: Partial<ToastInput> = {}) {
  return showToast({ ...options, type: "error", title, ...(description ? { description } : {}) });
}

let readActiveThread: () => ToastThreadRef | null = () => null;
/** The host says which thread is open (the web's useActiveThreadRefFromRoute); a signal read inside keeps `visibleToasts` current. */
export function setActiveThreadReader(read: (() => ToastThreadRef | null) | null) {
  readActiveThread = read ?? (() => null);
}

/** shouldRenderThreadScopedToast: a toast with a thread shows only on that thread; one without shows everywhere. */
export function shouldRenderThreadScopedToast(toast: { threadRef?: ToastThreadRef }, active: ToastThreadRef | null): boolean {
  const ref = toast.threadRef;
  if (!ref) return true;
  if (active === null || ref.threadId !== active.threadId) return false;
  return ref.environmentId === undefined || active.environmentId === undefined || ref.environmentId === active.environmentId;
}

/** The toasts still showing under the stack's limit: the ones the host paints, newest first. */
export function visibleToasts(): ToastItem[] {
  const active = readActiveThread();
  return items().filter((toast) => shouldRenderThreadScopedToast(toast, active)).slice(0, TOAST_LIMIT);
}

export function toastById(id: string): ToastItem | undefined {
  return items().find((item) => item.id === id);
}
