import { expect, test } from "nsh/test";
import { commitSecretReference, isSecretReference, secretSources, settingsSecretLiteral } from "./pages/settings/secretSource";
import { retryingStream } from "./environments/environmentSession";

test("secret references: shape, 1Password validation, and sources only with the feature and server support", () => {
  expect(isSecretReference({ provider: "op", reference: "op://v/i/f" })).toBe(true);
  expect(isSecretReference("literal")).toBe(false);
  expect(settingsSecretLiteral({ provider: "op", reference: "op://v/i/f" })).toBe("");
  const kind = () => "one_password";
  expect(commitSecretReference("op", kind, "op://vault/item/field")).toEqual({ secret: { provider: "op", reference: "op://vault/item/field" } });
  expect(commitSecretReference("op", kind, "nope")).toEqual({ rejected: "Use a 1Password reference like op://vault/item/field." });
  expect(commitSecretReference("op", kind, " ")).toEqual({ cleared: true });
  const settings = { secretProviders: { op: { kind: "one_password", label: "Work", config: { account: "my.1password.com" } }, bad: { kind: "other", label: "X", config: {} } } };
  expect(secretSources(settings, { secretReferences: true }, true)).toEqual([{ id: "op", kind: "one_password", label: "Work" }]);
  expect(secretSources(settings, { secretReferences: false }, true)).toEqual([]);
  expect(secretSources(settings, { secretReferences: true }, false)).toEqual([]);
});

test("a long-lived stream resubscribes after a failure or a normal end, and stops when told", async () => {
  let subscribes = 0;
  let fail: ((error: Error) => void) | null = null;
  let end: (() => void) | null = null;
  const stop = retryingStream((_m, _p, _v, onError, onEnd) => { subscribes += 1; fail = onError; end = onEnd ?? null; return () => {}; }, "s", {}, () => {});
  fail!(new Error("boom"));
  for (let i = 0; i < 100 && subscribes < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(subscribes).toBe(2);
  end!();
  for (let i = 0; i < 100 && subscribes < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(subscribes).toBe(3);
  stop();
  end!();
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(subscribes).toBe(3);
});
