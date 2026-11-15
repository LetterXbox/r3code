// The compact wire forms of orchestration.subscribeThread that the reference opts into (client-runtime state/threads.ts
// makeSubscribeInput), undone before any reducer sees an item, so the timeline gets the same shapes as without them:
// - acceptCompactIds: contracts orchestrationV2IdTable.ts withRecordIdTable (an `ids` table on snapshot items).
// - acceptCompactTurnItems: shared orchestrationV2BoundedSnapshot.ts restoreLocalVisibleTurnItems (`turnItemsOmitLocalVisible`).
// - acceptDedupedBodies: shared orchestrationV2DedupedBodies.ts (`textOmitted`, `filesOmitted`, `promptOmitted`,
//   `resultOmitted` bodies restored from the records the subscription holds; client-runtime orchestrationV2Projection.ts
//   latestBodies for events).

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isIdKey = (key: string) => key === "id" || key.endsWith("Id");
const isIdListKey = (key: string) => key.endsWith("Ids");

/** orchestrationV2IdTable.ts expandRecordIds: mutates parsed JSON in place. */
export function expandRecordIds(container: Json, ids: ReadonlyArray<unknown>): void {
  const expandRecord = (entry: Json) => {
    for (const key in entry) {
      const value = entry[key];
      if (typeof value === "number") {
        if (isIdKey(key)) entry[key] = ids[value];
      } else if (Array.isArray(value)) {
        if (isIdListKey(key)) for (let i = 0; i < value.length; i++) if (typeof value[i] === "number") value[i] = ids[value[i] as number];
      } else if (key === "item" && isObject(value)) {
        expandRecord(value);
      }
    }
  };
  for (const key in container) {
    const value = container[key];
    if (Array.isArray(value)) { for (const entry of value) if (isObject(entry)) expandRecord(entry); }
    else if (isObject(value)) expandRecord(value);
  }
}

/** withRecordIdTable's decode for OrchestrationV2ThreadStreamItem: only a snapshot's projection holds records. */
export function expandStreamItemIds(raw: Json): Json {
  if (!Array.isArray(raw.ids)) return raw;
  const ids = raw.ids as unknown[];
  delete raw.ids;
  const target = raw.kind === "snapshot" ? raw.projection : undefined;
  if (isObject(target)) expandRecordIds(target, ids);
  return raw;
}

interface BodySource {
  messageText: (id: unknown) => string | undefined;
  checkpointFiles: (id: unknown) => unknown[] | undefined;
  subagent: (id: unknown) => Json | undefined;
}

/** orchestrationV2DedupedBodies.ts restoreSubagentBodies. */
export function restoreSubagentBodies(value: Json, previous: Json | undefined): Json {
  if (!previous) return value;
  const prompt = value.promptOmitted === true && previous.promptOmitted !== true;
  const result = value.resultOmitted === true && previous.resultOmitted !== true;
  if (!prompt && !result) return value;
  const { promptOmitted, resultOmitted, ...rest } = value;
  return {
    ...rest,
    ...(prompt ? { prompt: previous.prompt } : promptOmitted === true ? { promptOmitted } : {}),
    ...(result ? { result: previous.result } : resultOmitted === true ? { resultOmitted } : {}),
  };
}

/** orchestrationV2DedupedBodies.ts restoreTurnItemBodies. */
export function restoreTurnItemBodies(item: Json, source: BodySource): Json {
  switch (item.type) {
    case "user_message":
    case "assistant_message": {
      const text = item.textOmitted === true ? source.messageText(item.messageId) : undefined;
      if (text === undefined) return item;
      const { textOmitted: _textOmitted, ...rest } = item;
      return { ...rest, text };
    }
    case "checkpoint": {
      const files = item.filesOmitted === true ? source.checkpointFiles(item.checkpointId) : undefined;
      if (files === undefined) return item;
      const { filesOmitted: _filesOmitted, ...rest } = item;
      return { ...rest, files };
    }
    case "subagent":
      return item.promptOmitted === true || item.resultOmitted === true ? restoreSubagentBodies(item, source.subagent(item.subagentId)) : item;
    default:
      return item;
  }
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

function projectionBodySource(projection: Json): BodySource {
  const messages = new Map(list(projection.messages).map((message) => [message.id, message.text]));
  const checkpoints = new Map(list(projection.checkpoints).map((checkpoint) => [checkpoint.id, checkpoint.files]));
  const subagents = new Map(list(projection.subagents).map((subagent) => [subagent.id, subagent]));
  return {
    messageText: (id) => { const text = messages.get(id); return typeof text === "string" ? text : undefined; },
    checkpointFiles: (id) => { const files = checkpoints.get(id); return Array.isArray(files) ? files : undefined; },
    subagent: (id) => subagents.get(id),
  };
}

const threadIdOf = (projection: Json) => (isObject(projection.thread) ? projection.thread.id : undefined);
const isLocalRow = (projection: Json, row: Json) => row.visibility === "local" || row.sourceThreadId === threadIdOf(projection);

/** orchestrationV2BoundedSnapshot.ts restoreLocalVisibleTurnItems: local visible rows lead the full turn item list. */
export function restoreLocalVisibleTurnItems(projection: Json): Json {
  const local = list(projection.visibleTurnItems).filter((row) => isLocalRow(projection, row)).map((row) => row.item);
  if (local.length === 0) return projection;
  return { ...projection, turnItems: [...local, ...(Array.isArray(projection.turnItems) ? projection.turnItems : [])] };
}

/** orchestrationV2DedupedBodies.ts restoreSnapshotBodies: maps each local item once, so a shared item stays one object. */
export function restoreSnapshotBodies(projection: Json): Json {
  const source = projectionBodySource(projection);
  const mapped = new Map<unknown, unknown>();
  let changed = false;
  const once = (item: unknown) => {
    if (!isObject(item)) return item;
    let next = mapped.get(item);
    if (next === undefined) {
      next = restoreTurnItemBodies(item, source);
      mapped.set(item, next);
      changed ||= next !== item;
    }
    return next;
  };
  const visibleTurnItems = list(projection.visibleTurnItems).map((row) => {
    if (!isLocalRow(projection, row)) return row;
    const item = once(row.item);
    return item === row.item ? row : { ...row, item };
  });
  const turnItems = Array.isArray(projection.turnItems) ? projection.turnItems.map(once) : projection.turnItems;
  return changed ? { ...projection, visibleTurnItems, turnItems } : projection;
}

/**
 * One decoder per subscription: it remembers the message texts, checkpoint files and subagents the stream delivered,
 * which is what a deduped event body is restored from (the reference reads them from its projection).
 */
const deferredByDecoder = new WeakMap<(value: unknown) => unknown, Map<unknown, unknown>>();
/** A loaded work anchor (loadDeferredWork): later updates of it no longer carry the collapsed-work cursor. */
export function forgetDeferredWork(decoder: (value: unknown) => unknown, itemId: string) {
  deferredByDecoder.get(decoder)?.delete(itemId);
}

export function createThreadWireDecoder(): (value: unknown) => unknown {
  // orchestrationV2Projection.ts turn-item.updated: an update keeps the held item's wire-only `deferredWork`.
  const deferred = new Map<unknown, unknown>();
  const messages = new Map<unknown, string>();
  const checkpoints = new Map<unknown, unknown[]>();
  const subagents = new Map<unknown, Json>();
  const source: BodySource = {
    messageText: (id) => messages.get(id),
    checkpointFiles: (id) => checkpoints.get(id),
    subagent: (id) => subagents.get(id),
  };
  const hold = (projection: Json) => {
    messages.clear(); checkpoints.clear(); subagents.clear(); deferred.clear();
    for (const item of [...(Array.isArray(projection.turnItems) ? projection.turnItems : []), ...list(projection.visibleTurnItems).map((row) => row.item)]) {
      if (isObject(item) && isObject(item.deferredWork)) deferred.set(item.id, item.deferredWork);
    }
    for (const message of list(projection.messages)) if (typeof message.text === "string") messages.set(message.id, message.text);
    for (const checkpoint of list(projection.checkpoints)) if (Array.isArray(checkpoint.files)) checkpoints.set(checkpoint.id, checkpoint.files);
    for (const subagent of list(projection.subagents)) subagents.set(subagent.id, subagent);
  };
  const decode = (value: unknown): unknown => {
    if (!isObject(value)) return value;
    const item = expandStreamItemIds(value);
    if (item.kind === "snapshot" && isObject(item.projection)) {
      const { turnItemsOmitLocalVisible, ...rest } = item;
      const projection = restoreSnapshotBodies(turnItemsOmitLocalVisible === true ? restoreLocalVisibleTurnItems(item.projection) : item.projection);
      hold(projection);
      return { ...rest, projection };
    }
    if (item.kind !== "event" || !isObject(item.event) || !isObject(item.event.payload)) return item;
    const event = item.event;
    const payload = event.payload as Json;
    if (event.type === "message.updated") {
      if (typeof payload.text === "string") messages.set(payload.id, payload.text);
      return item;
    }
    if (event.type === "checkpoint.captured") {
      if (Array.isArray(payload.files)) checkpoints.set(payload.id, payload.files);
      return item;
    }
    if (event.type === "subagent.updated") {
      const restored = restoreSubagentBodies(payload, subagents.get(payload.id));
      subagents.set(restored.id, restored);
      return restored === payload ? item : { ...item, event: { ...event, payload: restored } };
    }
    if (event.type === "turn-item.updated") {
      let restored = restoreTurnItemBodies(payload, source);
      const held = deferred.get(restored.id);
      if (held !== undefined && restored.deferredWork === undefined) restored = { ...restored, deferredWork: held };
      else if (isObject(restored.deferredWork)) deferred.set(restored.id, restored.deferredWork);
      return restored === payload ? item : { ...item, event: { ...event, payload: restored } };
    }
    return item;
  };
  deferredByDecoder.set(decode, deferred);
  return decode;
}
