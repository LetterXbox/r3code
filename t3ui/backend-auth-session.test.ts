// environments/primary/auth.ts waitForAuthenticatedSessionAfterBootstrap + retryTransientBootstrap, against backend/auth.ts.
import { expect, test } from "nsh/test";
import { AUTH_SESSION_TIMEOUT_MESSAGE, waitForAuthenticatedSession, type SessionWaitDeps } from "./backend/auth";

function deps(answers: Array<{ status: number; authenticated?: boolean } | "network">) {
  let clock = 0;
  const urls: string[] = [];
  const auth: string[] = [];
  const d: SessionWaitDeps = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetcher: async (url, init) => {
      urls.push(url);
      auth.push(init.headers.authorization ?? "");
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next === "network") throw new TypeError("fetch failed");
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => ({ authenticated: next.authenticated === true }) };
    },
  };
  return { d, urls, auth, elapsed: () => clock };
}

test("resolves once the session reads authenticated, with the bearer on the session endpoint", async () => {
  const { d, urls, auth } = deps([{ status: 200, authenticated: false }, { status: 200, authenticated: true }]);
  await waitForAuthenticatedSession("ws://127.0.0.1:3773/ws", "tok", d);
  expect(urls).toEqual(["http://127.0.0.1:3773/api/auth/session", "http://127.0.0.1:3773/api/auth/session"]);
  expect(auth[0]).toBe("Bearer tok");
});

test("times out after 2 s of not-authenticated with the reference's message", async () => {
  const { d, elapsed } = deps([{ status: 200, authenticated: false }]);
  let message = "";
  try { await waitForAuthenticatedSession("ws://127.0.0.1:3773/ws", "tok", d); } catch (error) { message = (error as Error).message; }
  expect(message).toBe(AUTH_SESSION_TIMEOUT_MESSAGE);
  expect(message).toBe("Timed out waiting for authenticated session after bootstrap.");
  expect(elapsed()).toBe(2000);
});

test("502/503/504 and network failures are retried; other statuses fail at once", async () => {
  const ok = deps([{ status: 503 }, "network", { status: 200, authenticated: true }]);
  await waitForAuthenticatedSession("ws://127.0.0.1:3773/ws", "tok", ok.d);
  expect(ok.elapsed()).toBe(1000);
  const bad = deps([{ status: 500 }]);
  let message = "";
  try { await waitForAuthenticatedSession("ws://127.0.0.1:3773/ws", "tok", bad.d); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("Primary environment request failed during fetch-session-state (HTTP 500).");
});
