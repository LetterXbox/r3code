import { expect, test } from "nsh/test";
import { compactThreadAvailable, freshSessionAvailable, idleCompactionMode, resumeCompactionOffered, sideChatDisabledReason } from "./composerAvailability";

const ok = { isSideChat: false, isSubagent: false, environmentKnown: true, environmentSupportsSideChats: true, isServerThread: true };

test("side chats say why they cannot start, in the web's order", () => {
  expect(sideChatDisabledReason(ok)).toBe(null);
  expect(sideChatDisabledReason({ ...ok, isSideChat: true })).toBe("Side chats cannot start side chats.");
  expect(sideChatDisabledReason({ ...ok, isSubagent: true })).toBe("Subagent threads cannot start side chats.");
  expect(sideChatDisabledReason({ ...ok, environmentKnown: false })).toBe("Side chats are not ready yet. Try again in a moment.");
  expect(sideChatDisabledReason({ ...ok, environmentSupportsSideChats: false })).toBe("Update this environment's R3 Code server to use side chats.");
  expect(sideChatDisabledReason({ ...ok, isServerThread: false })).toBe("Side chats start after the first message.");
});

test("/clear needs messages, server support and no pending request", () => {
  expect(freshSessionAvailable({ messageCount: 2, environmentSupportsFreshContext: true, pendingRequests: false })).toBe(true);
  expect(freshSessionAvailable({ messageCount: 0, environmentSupportsFreshContext: true, pendingRequests: false })).toBe(false);
  expect(freshSessionAvailable({ messageCount: 2, environmentSupportsFreshContext: false, pendingRequests: false })).toBe(false);
  expect(freshSessionAvailable({ messageCount: 2, environmentSupportsFreshContext: true, pendingRequests: true })).toBe(false);
});

test("compaction is offered only for an idle, started thread whose provider has /compact", () => {
  const base = { isServerThread: true, hasMessages: true, providerOffersCompact: true, running: false, pendingRequests: false, connected: true };
  expect(compactThreadAvailable(base)).toBe(true);
  expect(compactThreadAvailable({ ...base, running: true })).toBe(false);
  expect(compactThreadAvailable({ ...base, providerOffersCompact: false })).toBe(false);
  expect(resumeCompactionOffered({ compactAvailable: true, idleCompactionMode: "onReturn", hasHeldQueue: false, usageOffered: true })).toBe(true);
  expect(resumeCompactionOffered({ compactAvailable: true, idleCompactionMode: "off", hasHeldQueue: false, usageOffered: true })).toBe(false);
  expect(resumeCompactionOffered({ compactAvailable: true, idleCompactionMode: "onReturn", hasHeldQueue: true, usageOffered: true })).toBe(false);
});

test("the idle compaction mode follows the instance, then the environment, then the legacy switch", () => {
  expect(idleCompactionMode(null, "claude")).toBe("onReturn");
  expect(idleCompactionMode({ compactIdleThreads: true }, "claude")).toBe("beforeCacheExpires");
  expect(idleCompactionMode({ idleCompaction: "off", compactIdleThreads: true }, "claude")).toBe("off");
  expect(idleCompactionMode({ idleCompaction: "off", providerInstances: { claude: { config: { idleCompaction: "onReturn" } } } }, "claude")).toBe("onReturn");
  expect(idleCompactionMode({ idleCompaction: "off", providerInstances: { claude: { config: { idleCompaction: "default" } } } }, "claude")).toBe("off");
});
