import { expect, test } from "nsh/test";
import { clearToasts, toastById, toasts } from "../toast/toastState";
import {
  legacyMigrationToast,
  hostFreezeNotice,
  LEGACY_MIGRATION_TOAST_ID,
  resetHostFreezeToastsForTest,
  showHostFreezeToast,
} from "./lifecycleToasts";
import {
  legacyThreadMigration,
  observeConfigEvent,
  observeLifecycleEvent,
  readEventLoopStall,
  readWelcome,
  resetServerStreams,
  serverConfigReceived,
  serverEventLoopStall,
  serverWelcome,
} from "./serverStreams";

// ServerLifecycleStreamEvent payloads from packages/contracts server.ts.
const environment = { environmentId: "env-1", label: "legion", platform: { os: "darwin", arch: "arm64" }, serverVersion: "0.1.8" };
const welcomeEvent = {
  version: 1, sequence: 1, type: "welcome",
  payload: { environment, cwd: "/Users/me/work", projectName: "work", bootstrapStatus: "complete", bootstrapProjectId: "project-1", bootstrapThreadId: "thread-1", bootstrapProjectCreated: true, bootstrapThreadCreated: true },
};

test("a welcome event carries the bootstrap the first-run gate reads", () => {
  resetServerStreams();
  expect(serverWelcome()).toBe(null);
  expect(observeLifecycleEvent(welcomeEvent)).toBe("welcome");
  expect(serverWelcome()).toEqual({
    environmentId: "env-1", cwd: "/Users/me/work", projectName: "work", bootstrapStatus: "complete", bootstrapProjectId: "project-1",
    bootstrapThreadId: "thread-1", bootstrapProjectCreated: true, bootstrapThreadCreated: true,
  });
  expect(readWelcome({ environment, cwd: "/x", projectName: "x" })?.bootstrapStatus).toBe(null);
  expect(readWelcome("nope")).toBe(null);
});

test("ready and unknown lifecycle events change nothing", () => {
  resetServerStreams();
  expect(observeLifecycleEvent({ version: 1, sequence: 2, type: "ready", payload: { at: "2026-11-11T10:00:00.000Z", environment } })).toBe("ready");
  expect(observeLifecycleEvent({ type: "other" })).toBe(null);
  expect(observeLifecycleEvent(undefined)).toBe(null);
  expect(serverWelcome()).toBe(null);
});

test("a legacy migration shows a loading toast while it runs and closes it when it completes", () => {
  resetServerStreams();
  clearToasts();
  observeLifecycleEvent({ version: 1, sequence: 3, type: "legacyThreadMigration", payload: { status: "running", totalThreadCount: 1234 } });
  expect(legacyThreadMigration()).toEqual({ status: "running", totalThreadCount: 1234 });
  const toast = legacyMigrationToast(legacyThreadMigration());
  expect(toast).toEqual({
    type: "loading", title: "Restoring your threads…", timeoutMs: 0,
    description: `Migrating ${(1234).toLocaleString()} threads from the previous version. You can keep working while this finishes.`,
  });
  expect(legacyMigrationToast({ status: "running", totalThreadCount: 1 })?.description).toContain("Migrating 1 thread from");
  observeLifecycleEvent({ version: 1, sequence: 4, type: "legacyThreadMigration", payload: { status: "complete", totalThreadCount: 1234 } });
  expect(legacyMigrationToast(legacyThreadMigration())).toBe(null);
  expect(toastById(LEGACY_MIGRATION_TOAST_ID)).toBe(undefined);
});

const stall = { detectedAt: "2026-11-11T10:00:00.000Z", durationMs: 8400, loadAverage: 14.2, cpuCount: 8 };

test("the config snapshot's last event loop stall is read, and absent ones are null", () => {
  resetServerStreams();
  expect(serverConfigReceived()).toBe(false);
  observeConfigEvent({ type: "snapshot", config: { lastEventLoopStall: stall } });
  expect(serverConfigReceived()).toBe(true);
  expect(serverEventLoopStall()).toEqual(stall);
  observeConfigEvent({ type: "snapshot", config: {} });
  expect(serverEventLoopStall()).toBe(null);
  expect(readEventLoopStall({ lastEventLoopStall: { detectedAt: 1 } })).toBe(null);
});

test("a host freeze names the host and its load, once per stall", () => {
  expect(hostFreezeNotice("legion", stall)).toEqual({ title: "legion froze for 8s", description: "Its CPU is overloaded (load 14 on 8 cores)." });
  expect(hostFreezeNotice("legion", { ...stall, loadAverage: 2 })?.description).toBe("R3 Code on legion was too busy to answer.");
  expect(hostFreezeNotice("legion", { detectedAt: stall.detectedAt, durationMs: 3000, cpuCount: 4 })?.description).toBe("R3 Code on legion was too busy to answer.");
  expect(hostFreezeNotice("legion", null)).toBe(null);
  resetHostFreezeToastsForTest();
  clearToasts();
  expect(showHostFreezeToast(stall, "legion")).toBe(true);
  expect(showHostFreezeToast(stall, "legion")).toBe(false);
  expect(toasts().length).toBe(1);
  expect(toasts()[0]).toMatchObject({ type: "warning", title: "legion froze for 8s" });
  expect(showHostFreezeToast({ ...stall, detectedAt: "2026-11-11T11:00:00.000Z" }, "legion")).toBe(true);
  clearToasts();
});
