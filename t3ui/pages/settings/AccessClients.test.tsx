import { expect, open, test } from "nsh/test";
import { applyAccessEvent, canRevokeOtherClients, EMPTY_ACCESS, formatExpiresInLabel, sortClientSessions, summarizeAuthorizedClients } from "./environments/accessClients";

const link = { id: "l1", label: "iPad", scopes: ["orchestration:read"], createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z" };
const session = (id: string, over: Record<string, unknown> = {}) => ({ sessionId: id, subject: "s", scopes: ["a"], issuedAt: "2026-01-01T00:00:00Z", lastConnectedAt: null, connected: false, current: false, client: { deviceType: "desktop", os: "macOS" }, ...over });

test("access stream events build the authorized clients list", () => {
  let state = applyAccessEvent(EMPTY_ACCESS, { type: "snapshot", payload: { pairingLinks: [link], clientSessions: [session("a"), session("b", { current: true })] } });
  expect(state.loaded).toBe(true);
  expect(state.pairingLinks.length).toBe(1);
  expect(sortClientSessions(state.clientSessions)[0]!.sessionId).toBe("b");
  state = applyAccessEvent(state, { type: "clientUpserted", payload: session("c", { connected: true }) });
  expect(state.clientSessions.length).toBe(3);
  state = applyAccessEvent(state, { type: "clientRemoved", payload: { sessionId: "a" } });
  state = applyAccessEvent(state, { type: "pairingLinkRemoved", payload: { id: "l1" } });
  expect(state.clientSessions.map((item) => item.sessionId).sort()).toEqual(["b", "c"]);
  expect(state.pairingLinks.length).toBe(0);
  expect(summarizeAuthorizedClients(state.clientSessions, [])).toBe("2 clients");
  expect(summarizeAuthorizedClients([1], [1])).toBe("1 client · 1 pairing link");
  expect(canRevokeOtherClients(state.clientSessions)).toBe(true);
  expect(canRevokeOtherClients([session("b", { current: true })] as never)).toBe(false);
});

test("expiry labels follow the web's formatExpiresInLabel", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  expect(formatExpiresInLabel("2025-12-31T23:59:00Z", now)).toBe("Expired");
  expect(formatExpiresInLabel("2026-01-01T00:00:03Z", now)).toBe("Expires in a moment");
  expect(formatExpiresInLabel("2026-01-01T00:00:30Z", now)).toBe("Expires in 30s");
  expect(formatExpiresInLabel("2026-01-01T00:05:00Z", now)).toBe("Expires in 5m");
  expect(formatExpiresInLabel("2026-01-01T01:30:00Z", now)).toBe("Expires in 1h 30m");
  expect(formatExpiresInLabel("2026-01-03T00:00:00Z", now)).toBe("Expires in 2d");
});

test("Sharing & access says so with no environment, and opens Create pairing link as a modal with one", async () => {
  const app = await open("../../App.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+,");
  await app.press("text:Sharing & access");
  await expect(app.texts()).toContain("No environment selected");
  await app.press("text:Environments");
  await app.press("label:Add environment");
  await app.type("label:Host", "127.0.0.1:1");
  await app.type("label:Pairing code", "CODE");
  await app.press("label:Confirm add environment");
  await app.press("text:Sharing & access");
  await app.press("label:Create link");
  for (const text of ["Create pairing link", "Client label (optional)", "View environment", "Use terminals"]) await expect(app.texts()).toContain(text);
  await app.press("label:Cancel");
  await expect(app.texts()).not.toContain("Client label (optional)");
});
