import { expect, test } from "nsh/test";
import { parseSessionGrant, sessionGrantsProvidersManage } from "../../../backend/providers";
import { checkedParts } from "./logic";

const grant = (value: unknown) => { const session = parseSessionGrant(value); return session !== null && sessionGrantsProvidersManage(session); };

test("providers:manage is read from the session payload the server sends", () => {
  expect(grant({ authenticated: true, scopes: ["orchestration:read"], permissions: ["providers:manage"] })).toBe(true);
  expect(grant({ authenticated: true, scopes: ["orchestration:read"] })).toBe(false);
  expect(grant({ authenticated: true, scopes: ["orchestration:operate"] })).toBe(true);
  expect(grant({ authenticated: true, scopes: ["orchestration:operate"], auth: { serverUpdateScope: "x" } })).toBe(false);
  expect(grant({ authenticated: true, permissions: ["settings:write"], scopes: ["orchestration:operate"] })).toBe(false);
  expect(grant({ authenticated: false, permissions: ["providers:manage"] })).toBe(false);
  expect(grant("nope")).toBe(false);
});

test("the checked label splits its elapsed value so it can render in mono", () => {
  const at = (iso: string) => [{ checkedAt: iso }] as never;
  const now = Date.parse("2026-11-11T12:00:00Z");
  expect(checkedParts(at("2026-11-11T11:55:00Z"), now)).toEqual({ value: "5m", suffix: "ago" });
  expect(checkedParts(at("2026-11-11T11:59:50Z"), now)).toEqual({ value: "just now", suffix: "" });
  expect(checkedParts([], now)).toBeNull();
});
