import { expect, test } from "nsh/test";
import { buildEnvironmentOptions, shouldShowEnvironmentIndicator } from "./environmentOptions";

const saved = [
  { id: "env-a", label: "Studio", url: "wss://studio.example.com/ws", enabled: true },
  { id: "env-b", label: "Off", url: "wss://off.example.com/ws", enabled: false },
  { id: "env-c", label: "This one", url: "ws://127.0.0.1:3773/ws", enabled: true },
];

test("the connected environment comes first, then the enabled saved ones, never the connection itself", () => {
  const options = buildEnvironmentOptions({ connected: { id: "env-c", label: "Laptop" }, currentUrl: "ws://127.0.0.1:3773/ws", saved });
  expect(options.map((item) => item.label)).toEqual(["Laptop", "Studio"]);
  expect(options[0]).toMatchObject({ isPrimary: true, machine: "laptop" });
  expect(options[1]).toMatchObject({ isPrimary: false, machine: "server", url: "wss://studio.example.com/ws" });
});

test("a single machine shows no Run on control; several machines do", () => {
  const single = buildEnvironmentOptions({ connected: { id: "p", label: "Laptop" }, currentUrl: "ws://127.0.0.1:1/ws", saved: [] });
  expect(shouldShowEnvironmentIndicator({ options: single, activeId: "p" })).toBe(false);
  const several = buildEnvironmentOptions({ connected: { id: "p", label: "Laptop" }, currentUrl: "ws://127.0.0.1:1/ws", saved });
  expect(shouldShowEnvironmentIndicator({ options: several, activeId: "p" })).toBe(true);
});
