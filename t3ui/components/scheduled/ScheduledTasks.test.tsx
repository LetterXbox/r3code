import { expect, open, test } from "nsh/test";

test("scheduled task actions use the selected task and reflect server updates", async () => {
  const app = await open("./ScheduledFixture.tsx", { width: 1000, height: 800 });
  await expect(app.texts()).toContain("Every 15 min · Not scheduled");
  await app.press("label:Actions for Review");
  await app.press("label:Edit Review");
  await expect(app.texts()).toContain("edit:task-1");
  await expect(app.enabled("label:Enable Review")).toBe(false);
  await app.press("label:Close task editor");
  await app.press("label:Actions for Review");
  await app.press("label:Run Review now");
  await expect(app.texts()).toContain("run:task-1");
  await app.press("label:Enable Review");
  await expect(app.texts()).toContain("Every 15 min · Paused");
  await app.press("label:Actions for Review");
  await app.press("label:Delete Review");
  await expect(app.texts()).toContain("delete:task-1");
  await expect(app.shows("label:Enable Review")).toBe(false);
});

test("a rejected action reports the error without changing the task", async () => {
  const app = await open("./ScheduledFixture.tsx", { width: 1000, height: 800 });
  await app.press("label:Fail task action");
  await app.press("label:Enable Review");
  await expect(app.texts()).toContain("Permission denied");
  await expect(app.texts()).toContain("Every 15 min · Not scheduled");
});

test("the app explains that scheduled tasks need a connected environment", async () => {
  const app = await open("../../App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("label:Settings sections >> text:Scheduled tasks");
  await expect(app.texts()).toContain("Connect an environment to manage scheduled tasks.");
  await expect(app.enabled("label:New scheduled task")).toBe(false);
});

test("presses inside the editor dialog (its title, description, a field label, the Name field) keep it open", async () => {
  const app = await open("./ScheduledEditorFixture.tsx", { width: 1000, height: 1400 });
  await app.press("text:New task");
  await app.press("text:Run a prompt automatically on an interval, at a fixed time, once at a set date, or when a webhook is called.");
  await app.press("text:Name");
  await app.press("label:Scheduled task title");
  await app.type("label:Scheduled task title", "Still open");
  await expect(app.texts()).toContain("New task");
  await expect(app.texts()).not.toContain("closed");
});

test("the editor dialog validates required fields and submits the chosen weekdays and destination", async () => {
  const app = await open("./ScheduledEditorFixture.tsx", { width: 1000, height: 1400 });
  await expect(app.texts()).toContain("New task");
  await expect(app.texts()).toContain("Run a prompt automatically on an interval, at a fixed time, once at a set date, or when a webhook is called.");
  await app.press("label:Save scheduled task");
  await expect(app.texts()).toContain("Scheduled task is incomplete");
  await expect(app.texts()).toContain("Add a title, prompt, project, and model.");
  await app.type("label:Scheduled task title", "Review changes");
  await app.type("label:Scheduled task prompt", "Inspect the repository");
  await app.press("label:Run on Mon");
  await expect(app.shows("id:day-1-unselected")).toBe(true);
  await app.press("label:Destination mode = new_thread");
  await app.press("label:One thread, continuing the conversation");
  await app.press("label:Save scheduled task");
  await expect(app.texts()).toContain('saved:Review changes:{"type":"fixed_time","timeOfDay":"09:00","weekdays":[2,3,4,5]}:"continue"');
  await expect(app.texts()).toContain("closed");
});

test("an interval below a minute is refused and the webhook form offers its URL, filters and signature", async () => {
  const app = await open("./ScheduledEditorFixture.tsx", { width: 1000, height: 2200 });
  await app.type("label:Scheduled task title", "Hooked");
  await app.type("label:Scheduled task prompt", "Go");
  await app.press("label:Every interval");
  await app.clear("label:Interval in minutes");
  await app.type("label:Interval in minutes", "0.5");
  await app.press("label:Save scheduled task");
  await expect(app.texts()).toContain("Invalid interval");
  await app.press("label:On webhook");
  await expect(app.texts()).toContain("The URL appears after you save.");
  await app.press("label:Add filter");
  await app.type("label:Filter 1 path", "body.action");
  await app.type("label:Filter 1 value", "opened");
  await expect(app.value("label:Filter 1 path")).toBe("body.action");
  await expect(app.value("label:Filter 1 value")).toBe("opened");
  await app.press("label:Require signature");
  await expect(app.texts()).toContain("Reject requests without a valid HMAC-SHA256 signature of the body.");
  await app.press("label:Save scheduled task");
  await expect(app.texts()).toContain("Signing secret is required");
  await app.type("label:Signature secret", "s3cret");
  await app.press("label:Save scheduled task");
  await expect(app.texts()).toContain('saved:Hooked:{"type":"webhook","signature":{"header":"x-hub-signature-256","encoding":"hex","prefix":"sha256=","secret":"s3cret"},"maxDeliveryAgeMinutes":null,"dedupe":{},"filters":[{"path":"body.action","op":"equals","value":"opened"}]}:"new_thread"');
});

import { filterDrafts, isDedupeTemplate, parseFilterDrafts, scheduleFromDraft, taskToDraft, upsertFromDraft, webhookAddress, EMPTY_DRAFT } from "./taskDraft";

test("drafts round-trip a task and refuse what the contract would", () => {
  expect(parseFilterDrafts(filterDrafts([{ path: "body.a", op: "in", value: ["x", "y"] }]))).toEqual({ filters: [{ path: "body.a", op: "in", value: ["x", "y"] }] });
  expect(parseFilterDrafts([{ id: "f", path: "cookies.a", op: "equals", value: "x" }])).toEqual({ error: "Filter 1 needs a path under body, headers or query, and a value." });
  expect(parseFilterDrafts([{ id: "f", path: "body.a", op: "in", value: " , " }])).toEqual({ error: "Filter 1 needs a path under body, headers or query, and at least one value." });
  expect(isDedupeTemplate("{{headers.delivery-id}}")).toBe(true);
  expect(isDedupeTemplate("plain")).toBe(false);
  const task = { id: "t", title: "T", prompt: "P", enabled: true, schedule: { type: "interval" as const, everyMs: 900_000 }, projectId: "p", threadId: null, workspaceStrategy: { type: "worktree", baseRef: "dev", startFromOrigin: true }, modelSelection: { instanceId: "codex", model: "m" }, runtimeMode: "approval-required", interactionMode: "default", updatedAt: null, nextRunAt: null, lastRunStatus: "never", lastRunError: null, blockedByPolicy: null };
  const draft = taskToDraft(task);
  expect(draft).toMatchObject({ editingId: "t", scheduleMode: "interval", intervalMinutes: "15", workspaceMode: "worktree", baseRef: "dev", modelProvider: "codex" });
  expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 900_000 });
  expect(scheduleFromDraft({ ...draft, scheduleMode: "once", runAt: "nope" })).toBe(null);
  const ctx = { projectIds: ["p"], offersOnce: false, offersThreadModes: true, hasStoredSecret: false, commandId: "c" };
  expect(upsertFromDraft({ ...EMPTY_DRAFT, title: "x", prompt: "y", projectId: "p", modelProvider: "a", modelId: "b", scheduleMode: "once", runAt: "2027-01-01T09:00" }, ctx)).toEqual({ issues: [{ title: "Once is not available here", description: "This environment runs an older R3 Code. Update it to schedule a one-time task, or pick another schedule." }] });
  const ok = upsertFromDraft(draft, { ...ctx, offersOnce: true });
  expect("input" in ok && ok.input).toMatchObject({ id: "t", requireExisting: true, threadMode: "new_thread", workspaceStrategy: { type: "worktree", baseRef: "dev", startFromOrigin: true } });
  expect(webhookAddress({ path: "/hooks/a", url: null }, null)).toEqual({ address: "/hooks/a", copyable: false, note: "Link this environment to T3 Connect for a public URL." });
  expect(webhookAddress({ path: "/hooks/a", url: null }, "http://localhost:3773").note).toContain("Only this computer");
  expect(webhookAddress({ path: "/hooks/a", url: "https://x/y" }, null)).toEqual({ address: "https://x/y", copyable: true, note: null });
});

test("a failed subscription can be retried without accepting its stale events", async () => {
  const app = await open("./ScheduledStreamFixture.tsx", { width: 1000, height: 800 });
  await expect(app.texts()).toContain("Task stream ended");
  await app.press("label:Retry scheduled tasks");
  await expect(app.texts()).toContain("Fresh task");
  await app.press("label:Emit stale task result");
  await expect(app.texts()).toContain("Fresh task");
  await expect(app.texts()).not.toContain("Stale task");
});

import { deliveryLabel, readDelivery, readDeliveries } from "./WebhookDeliveries";

test("webhook deliveries read with the web's outcome labels", () => {
  expect(deliveryLabel({ outcome: "accepted", pendingWindow: false })).toBe("Ran");
  expect(deliveryLabel({ outcome: "accepted", pendingWindow: true })).toBe("Opened window");
  expect(deliveryLabel({ outcome: "rejected_signature", pendingWindow: false })).toBe("Bad signature");
  expect(deliveryLabel({ outcome: "something_new", pendingWindow: false })).toBe("something new");
  const row = { id: "d1", taskId: "t", receivedAt: "2026-11-11T12:00:00Z", method: "POST", contentType: null, bodyBytes: 3, outcome: "filtered", signatureVerified: true, missingFields: ["a"], error: "no match" };
  expect(readDeliveries({ deliveries: [row, { bad: true }] })).toHaveLength(1);
  const detail = readDelivery({ delivery: { ...row, query: "x=1", headers: { a: "b", n: 1 }, body: "hey", bodyTruncated: false, renderedPrompt: null } });
  expect(detail?.headers).toEqual({ a: "b" });
  expect(detail?.signatureVerified).toBe(true);
});

test("a webhook task says how T3 Connect relays its webhooks while offline", async () => {
  const app = await open("./WebhookDeliveryModeFixture.tsx", { width: 900, height: 400 });
  await expect(app.texts().join(" ")).toContain("Held for up to 24 hours while this environment is offline.");
  await expect(app.texts().join(" ")).toContain("Forwarded live. Requests fail while this environment is offline.");
});

test("the destination thread list searches all threads and says when none match", async () => {
  const app = await open("./ScheduledEditorFixture.tsx", { width: 1000, height: 1400 });
  await app.press("label:Destination mode = new_thread");
  await app.press("label:One thread, continuing the conversation");
  await app.press("label:Destination thread =  new-thread");
  await app.type("label:Search threads", "zzzz no such thread");
  await expect(app.texts()).toContain("No threads found.");
});
