// The "Choose what to show" list (chat/threadDetailsItems.ts). Ids are stored,
// so they never change. Only choices that differ from the default are kept, so a
// later default change reaches everyone else.
import { signal, Storage } from "nsh";

export const THREAD_DETAILS_ITEMS = [
  { id: "environment", label: "Environment and worktree", defaultVisible: true },
  { id: "openIn", label: "Open in editor", defaultVisible: true },
  { id: "scripts", label: "Project scripts", defaultVisible: true },
  { id: "branch", label: "Branch and pull request", defaultVisible: true },
  { id: "gitActions", label: "Git actions", defaultVisible: true },
  { id: "changes", label: "Changes", defaultVisible: true },
  { id: "servers", label: "Servers", defaultVisible: true },
  { id: "automations", label: "Automations", defaultVisible: true },
  { id: "lineage", label: "Lineage", defaultVisible: true },
  { id: "sideChats", label: "Side chats", defaultVisible: true },
  { id: "usage", label: "Usage limits", defaultVisible: false },
  { id: "context", label: "Context window", defaultVisible: false },
] as const;

export type ThreadDetailsItemId = (typeof THREAD_DETAILS_ITEMS)[number]["id"];
export type ThreadDetailsChoices = Partial<Record<ThreadDetailsItemId, boolean>>;
export type ThreadDetailsVisibility = Readonly<Record<ThreadDetailsItemId, boolean>>;

export function resolveThreadDetailsVisibility(choices: ThreadDetailsChoices): ThreadDetailsVisibility {
  return Object.fromEntries(THREAD_DETAILS_ITEMS.map((item) => [item.id, choices[item.id] ?? item.defaultVisible])) as Record<ThreadDetailsItemId, boolean>;
}

export function setThreadDetailsItem(choices: ThreadDetailsChoices, id: ThreadDetailsItemId, visible: boolean): ThreadDetailsChoices {
  const { [id]: _previous, ...rest } = choices;
  const item = THREAD_DETAILS_ITEMS.find((candidate) => candidate.id === id);
  return !item || visible === item.defaultVisible ? rest : { ...rest, [id]: visible };
}

export function isDefaultThreadDetailsVisibility(visibility: ThreadDetailsVisibility): boolean {
  return THREAD_DETAILS_ITEMS.every((item) => visibility[item.id] === item.defaultVisible);
}

/** Reads stored text defensively: unknown ids and non-booleans are dropped. */
export function readThreadDetailsChoices(value: unknown): ThreadDetailsChoices {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: ThreadDetailsChoices = {};
  for (const item of THREAD_DETAILS_ITEMS) {
    const choice = raw[item.id];
    if (typeof choice === "boolean" && choice !== item.defaultVisible) out[item.id] = choice;
  }
  return out;
}

const STORAGE_KEY = "threadDetailsItems";
const choices = signal<ThreadDetailsChoices>({});
let touched = false;

void Storage.getItem(STORAGE_KEY).then((text) => {
  if (touched || !text) return;
  try { choices.set(readThreadDetailsChoices(JSON.parse(text))); } catch { /* an unreadable copy is ignored */ }
}).catch(() => {});

function save(next: ThreadDetailsChoices) {
  touched = true;
  choices.set(next);
  void Storage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
}

export const threadDetailsVisibility = (): ThreadDetailsVisibility => resolveThreadDetailsVisibility(choices());
export const setThreadDetailsItemVisible = (id: ThreadDetailsItemId, visible: boolean) => save(setThreadDetailsItem(choices(), id, visible));
export const resetThreadDetailsItems = () => save({});
