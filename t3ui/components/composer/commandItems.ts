// The suggestion rows of ComposerCommandMenu (chat/useComposerMenuItems.ts): built-in `/` commands,
// the selected provider's own slash commands and skills, `$` skills, `#` pull requests and `@`
// workspace paths. Each row says what picking it does: insert text, or execute (open the picker).
import { scoreQueryMatch, sortRanked, normalizeSearchQuery } from "./searchRanking";
import type { RankedSearchResult } from "./searchRanking";
import type { ProviderCommand, ProviderSkill } from "./providerCatalog";
import { USAGE_LIMITS_COMMAND } from "./usageLimitsLogic";

export type BuiltInSlashCommand = "model" | "side" | "btw" | "clear";

export interface PullRequestRef {
  number: number; title: string; url: string; headBranch: string; baseBranch: string; state: string; isDraft: boolean;
  repository: string; projectId: string;
}

export type CommandItem =
  | { id: string; type: "slash-command"; command: BuiltInSlashCommand; label: string; description: string }
  | { id: string; type: "provider-slash-command"; command: ProviderCommand; label: string; description: string }
  | { id: string; type: "skill"; skill: ProviderSkill; label: string; description: string }
  | { id: string; type: "pull-request"; pullRequest: PullRequestRef; label: string; description: string }
  | { id: string; type: "path"; path: string; pathKind: "file" | "directory"; label: string; description: string }
  | { id: string; type: "model"; provider: string; model: string; source: string; label: string; description: string }
  | { id: string; type: "thread"; thread: { environmentId: string; threadId: string }; label: string; description: string }
  | { id: string; type: "environment"; environmentId: string; machine: "laptop" | "server"; label: string; description: string };

type SlashSearchItem = Extract<CommandItem, { type: "slash-command" | "provider-slash-command" | "skill" }>;

export const BUILT_IN_SLASH_COMMANDS: SlashSearchItem[] = [
  { id: "slash:model", type: "slash-command", command: "model", label: "/model", description: "Switch response model for this thread" },
];

/** useComposerMenuItems: /model always; /side and /btw where side chats start; /clear where a fresh session can. */
export function builtInSlashCommands(input: { sideChatAvailable?: boolean; sideChatDisabledReason?: string | null; freshSessionAvailable?: boolean }): SlashSearchItem[] {
  return [
    ...BUILT_IN_SLASH_COMMANDS,
    ...(input.sideChatAvailable ? [
      { id: "slash:side", type: "slash-command", command: "side", label: "/side", description: input.sideChatDisabledReason ?? "Ask a side question in a new side chat" } satisfies SlashSearchItem,
      { id: "slash:btw", type: "slash-command", command: "btw", label: "/btw", description: input.sideChatDisabledReason ?? "Same as /side" } satisfies SlashSearchItem,
    ] : []),
    ...(input.freshSessionAvailable ? [
      { id: "slash:clear", type: "slash-command", command: "clear", label: "/clear", description: "Start a fresh session; earlier messages stay visible" } satisfies SlashSearchItem,
    ] : []),
  ];
}

export const skillDisplayName = (skill: Pick<ProviderSkill, "name" | "displayName">) => skill.displayName?.trim() || skill.name;

/** Disabled and agent-only skills never reach a menu (isProviderSkillUserInvocable), nor do duplicates by name. */
export function userInvocableSkills(skills: readonly ProviderSkill[]): ProviderSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (!skill.enabled || !skill.userInvocable) return false;
    const key = skill.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const skillDescription = (skill: ProviderSkill, fallback: string) => skill.description ?? (skill.scope ? `${skill.scope} skill` : fallback);

/** Built-ins, then provider commands (minus those a skill already covers), then skills as `/skill:name`. */
export function slashMenuItems(input: {
  commands: readonly ProviderCommand[]; skills: readonly ProviderSkill[]; provider: string; showSkills: boolean; atPromptStart: boolean; usageLimitsOffered?: boolean;
  sideChatAvailable?: boolean; sideChatDisabledReason?: string | null; freshSessionAvailable?: boolean;
  /** `/compact` is listed only while the thread can be compacted by hand (compactSlashCommandAvailable). */
  compactAvailable?: boolean;
}): SlashSearchItem[] {
  const skills = input.showSkills ? userInvocableSkills(input.skills) : [];
  const skillNames = new Set(skills.map((skill) => skill.name.trim().toLowerCase()));
  // T3 adds /usage-limits for a provider whose snapshot reports limits (withUsageLimitsCommands).
  const commands = input.usageLimitsOffered && !input.commands.some((command) => command.name === USAGE_LIMITS_COMMAND.name)
    ? [...input.commands, { name: USAGE_LIMITS_COMMAND.name, description: USAGE_LIMITS_COMMAND.description, inputHint: null }]
    : input.commands;
  const providerItems = commands
    // T3's /clear replaces the provider's, which would clear a session T3 still treats as live.
    .filter((command) => (command.name !== "compact" || input.compactAvailable === true) && (command.name !== "clear" || input.freshSessionAvailable !== true))
    .filter((command) => !skillNames.has(command.name.trim().toLowerCase()))
    .map((command): SlashSearchItem => ({
      id: `provider-slash-command:${input.provider}:${command.name}`, type: "provider-slash-command", command,
      label: `/${command.name}`, description: command.description ?? command.inputHint ?? "Run provider command",
    }));
  const skillItems = skills.map((skill): SlashSearchItem => ({
    id: `skill:${input.provider}:${skill.name}`, type: "skill", skill, label: `/skill:${skill.name}`, description: skillDescription(skill, ""),
  }));
  // Provider commands work only at the message start; skills and built-ins work anywhere.
  const all = [...builtInSlashCommands(input), ...providerItems, ...skillItems];
  return input.atPromptStart ? all : all.filter((item) => item.type === "skill" || item.type === "slash-command");
}

function scoreSkill(skill: ProviderSkill, query: string): number | null {
  const scores = [
    scoreQueryMatch({ value: skill.name.toLowerCase(), query, exactBase: 0, prefixBase: 2, boundaryBase: 4, includesBase: 6, fuzzyBase: 100, boundaryMarkers: ["-", "_", "/"] }),
    scoreQueryMatch({ value: skillDisplayName(skill).toLowerCase(), query, exactBase: 1, prefixBase: 3, boundaryBase: 5, includesBase: 7, fuzzyBase: 110 }),
    // scoreProviderSkill: shortDescription at 20-26, the full description at 30-36 (a skill with only a description ranks it at 30).
    skill.longDescription !== undefined
      ? scoreQueryMatch({ value: (skill.description ?? "").toLowerCase(), query, exactBase: 20, prefixBase: 22, boundaryBase: 24, includesBase: 26 })
      : null,
    scoreQueryMatch({ value: ((skill.longDescription !== undefined ? skill.longDescription : skill.description) ?? "").toLowerCase(), query, exactBase: 30, prefixBase: 32, boundaryBase: 34, includesBase: 36 }),
    scoreQueryMatch({ value: (skill.scope ?? "").toLowerCase(), query, exactBase: 40, prefixBase: 42, includesBase: 44 }),
  ].filter((score): score is number => score !== null);
  return scores.length ? Math.min(...scores) : null;
}

function scoreSlashItem(item: SlashSearchItem, query: string): number | null {
  if (item.type === "skill") {
    if (query === "skill") return 0;
    const skillQuery = query.startsWith("skill:") ? query.slice("skill:".length) : query;
    const score = skillQuery ? scoreSkill(item.skill, skillQuery) : 0;
    if (score !== null) return score;
    return "skill".startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
  }
  const primary = item.type === "slash-command" ? item.command.toLowerCase() : item.command.name.toLowerCase();
  const scores = [
    scoreQueryMatch({ value: primary, query, exactBase: 0, prefixBase: 2, boundaryBase: 4, includesBase: 6, fuzzyBase: 100, boundaryMarkers: ["-", "_", "/"] }),
    scoreQueryMatch({ value: item.description.toLowerCase(), query, exactBase: 20, prefixBase: 22, boundaryBase: 24, includesBase: 26 }),
  ].filter((score): score is number => score !== null);
  return scores.length ? Math.min(...scores) : null;
}

/** searchSlashCommandItems: empty query lists everything; otherwise ranked by name, then description. */
export function searchSlashCommands(items: readonly SlashSearchItem[], query: string): SlashSearchItem[] {
  const needle = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!needle) return [...items];
  const ranked: RankedSearchResult<SlashSearchItem>[] = [];
  for (const item of items) {
    const score = scoreSlashItem(item, needle);
    if (score === null) continue;
    ranked.push({
      item, score,
      tieBreaker: item.type === "slash-command" ? `0\u0000${item.command}` : item.type === "provider-slash-command" ? `1\u0000${item.command.name}` : `2\u0000${item.skill.name}`,
    });
  }
  return sortRanked(ranked);
}

/** The `$` menu: every invocable skill, ranked by the typed query. */
export function skillMenuItems(skills: readonly ProviderSkill[], provider: string, query: string): CommandItem[] {
  const needle = normalizeSearchQuery(query, { trimLeadingPattern: /^\p{Sc}+/u });
  const ranked: RankedSearchResult<ProviderSkill>[] = [];
  for (const skill of userInvocableSkills(skills)) {
    const score = needle ? scoreSkill(skill, needle) : 0;
    if (score !== null) ranked.push({ item: skill, score, tieBreaker: skill.name });
  }
  return sortRanked(ranked).map((skill): CommandItem => ({
    id: `skill:${provider}:${skill.name}`, type: "skill", skill, label: skillDisplayName(skill), description: skillDescription(skill, "Run provider skill"),
  }));
}

/** `repository` null: the project's repository is unknown, so every entry of its list is offered. */
export function pullRequestItems(entries: readonly PullRequestRef[], repository: string | null, query: string, limit = 12): CommandItem[] {
  const needle = query.trim().toLowerCase();
  const sameRepo = repository === null ? [...entries] : entries.filter((entry) => entry.repository.trim().toLowerCase() === repository.trim().toLowerCase());
  const matches = sameRepo.filter((entry) => !needle || `${entry.number}`.startsWith(needle) || entry.title.toLowerCase().includes(needle) || entry.headBranch.toLowerCase().includes(needle));
  return matches.slice(0, limit).map((entry): CommandItem => ({
    id: `pull-request:${entry.projectId}:${entry.repository}:${entry.number}`, type: "pull-request", pullRequest: entry, label: `#${entry.number}`, description: entry.title,
  }));
}

export function parsePullRequests(value: unknown): PullRequestRef[] {
  const entries = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): PullRequestRef[] => {
    const item = entry as Record<string, unknown>;
    if (typeof item.number !== "number" || typeof item.title !== "string" || typeof item.url !== "string" || typeof item.repository !== "string" || typeof item.projectId !== "string") return [];
    return [{
      number: item.number, title: item.title, url: item.url, repository: item.repository, projectId: item.projectId,
      headBranch: typeof item.headBranch === "string" ? item.headBranch : "", baseBranch: typeof item.baseBranch === "string" ? item.baseBranch : "",
      state: typeof item.state === "string" ? item.state : "open", isDraft: item.isDraft === true,
    }];
  });
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** The models an `@` mention names (rankComposerModelMentions): at least two letters, every word starting a word of the
 * model's name, id or provider, best first, at most 8. Picking one inserts `model:<instance>/<model>`. */
/** A model's own name (AvailableModel labels read `Provider: Model`), as getDisplayModelName shows it. */
export const modelDisplayName = (label: string) => { const colon = label.indexOf(": "); return colon >= 0 ? label.slice(colon + 2) : label; };

export function modelMentionItems(models: readonly { provider: string; model: string; label: string }[], query: string): CommandItem[] {
  const words = query.replace(/[:/]+/g, " ").replace(/-+/g, " ").trim().toLowerCase();
  if (words.replace(/\s+/g, "").length < 2) return [];
  const tests = words.split(/\s+/).map((word) => (text: string) => text.split(/[^\p{L}\p{N}]+/u).some((part) => part.startsWith(word)));
  return models
    .filter((item) => { const haystack = `${item.label} ${item.model} ${item.provider}`.toLowerCase(); return tests.every((test) => test(haystack)); })
    .slice(0, 8)
    .map((item) => ({ id: `model:${item.provider}/${item.model}`, type: "model" as const, provider: item.provider, model: item.model, source: `model:${item.provider}/${item.model}`, label: modelDisplayName(item.label), description: item.label.slice(0, Math.max(0, item.label.indexOf(": "))) || item.provider }));
}

/** matchComposerThreadItems: threads an `@` mention can reference, at least one query character, matched on the title
 * (prefix, then word start, then substring) and ranked by recency, never the open thread nor an archived one, at most 5. */
export function threadMentionItems(
  threads: readonly { id: string; title: string; updatedAt: number; /** The thread's machine (server environment id) and id there, when not the default's. */ machineEnvironmentId?: string; localId?: string }[],
  input: { environmentId: string | undefined; excludeThreadId: string | undefined; query: string; /** Linked machines (peerLinks.list) by name: their threads are offered too. */ linkedEnvironments?: ReadonlyMap<string, string> },
): CommandItem[] {
  const needle = input.query.trim().toLowerCase();
  if (!needle || !input.environmentId) return [];
  const fallbackEnvironmentId = input.environmentId;
  const rank = (title: string) => { const folded = title.toLowerCase(); return folded.startsWith(needle) ? 0 : folded.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle)) ? 1 : folded.includes(needle) ? 2 : null; };
  return threads
    .filter((thread) => thread.id !== input.excludeThreadId && thread.title.trim().length > 0)
    // matchComposerThreadItems: this machine's threads and the linked machines'.
    .filter((thread) => { const env = thread.machineEnvironmentId ?? fallbackEnvironmentId; return env === fallbackEnvironmentId || input.linkedEnvironments?.has(env) === true; })
    .flatMap((thread) => { const score = rank(thread.title); return score === null ? [] : [{ thread, score }]; })
    .sort((left, right) => left.score - right.score || right.thread.updatedAt - left.thread.updatedAt)
    .slice(0, 5)
    .map(({ thread }): CommandItem => {
      const environmentId = thread.machineEnvironmentId ?? fallbackEnvironmentId;
      const threadId = thread.localId ?? thread.id;
      const machine = environmentId === fallbackEnvironmentId ? undefined : input.linkedEnvironments?.get(environmentId);
      return { id: `thread:${environmentId}:${threadId}`, type: "thread", thread: { environmentId, threadId }, label: thread.title, description: machine === undefined ? "Thread" : `Thread on ${machine}` };
    });
}

export function pathItem(entry: { path: string; kind: "file" | "directory" }): CommandItem {
  const slash = entry.path.lastIndexOf("/");
  return {
    id: `path:${entry.kind}:${entry.path}`, type: "path", path: entry.path, pathKind: entry.kind,
    label: basename(entry.path), description: slash > 0 ? entry.path.slice(0, slash) : "",
  };
}

export const EMPTY_STATE = {
  "slash-command": "No matching command.", path: "No matching files or folders.",
  skill: "No skills found. Try / to browse provider commands.", "pull-request": "No pull requests found in this repository.",
} as const;
/** useComposerMenuItems' pull-request empty state: unavailable, unreadable, no match for the query, or none at all. */
export function pullRequestEmptyState(state: { available: boolean; failed: boolean; query: string }): string {
  if (!state.available) return "Pull requests are not available for this project.";
  if (state.failed) return "Pull requests could not be read for this project.";
  return state.query ? `No pull request matches ${state.query}.` : EMPTY_STATE["pull-request"];
}

/** A pullRequests.list result (PullRequestListResult) reports this project in `errors`. */
export function pullRequestListFailed(value: unknown, projectId: string): boolean {
  const errors = (value as { errors?: unknown })?.errors;
  return Array.isArray(errors) && errors.some((error) => (error as { projectId?: unknown })?.projectId === projectId);
}

export const LOADING_STATE = {
  "slash-command": "Searching workspace skills...", path: "Searching workspace files...",
  skill: "Searching workspace skills...", "pull-request": "Finding pull request...",
} as const;

/** Parse the `projects.searchEntries` result into mention rows. */
export function parseSearchEntries(value: unknown): CommandItem[] {
  const entries = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): CommandItem[] => {
    const record = entry as { path?: unknown; kind?: unknown };
    if (typeof record.path !== "string" || (record.kind !== "file" && record.kind !== "directory")) return [];
    return [pathItem({ path: record.path, kind: record.kind })];
  });
}

/** shared/usageLimits.ts isUsageLimitsCommand: the whole prompt is `/usage-limits`. */
export const isUsageLimitsCommand = (prompt: string) => prompt.trim().toLowerCase() === "/usage-limits";

/** composerThreadItems.ts matchComposerEnvironmentItems: the user's other machines whose label contains the `@` query. */
export function environmentMentionItems(environments: readonly { environmentId: string; label: string; machine: "laptop" | "server" }[], input: { environmentId: string | undefined; query: string }): CommandItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return environments
    .filter((environment) => environment.environmentId !== input.environmentId && environment.label.toLowerCase().includes(query))
    .map((environment): CommandItem => ({ id: `environment:${environment.environmentId}`, type: "environment", environmentId: environment.environmentId, machine: environment.machine, label: environment.label, description: "Machine" }));
}
