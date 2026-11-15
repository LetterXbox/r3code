import { expect, test } from "nsh/test";
import { applyPrepareResult, isConfiguredAcpRegistryAgent, officialAcpIconUrl, readAcpAgents, resolveAcpNavigation } from "./acp";

test("registry agents are read with a default npx distribution", () => {
  const agents = readAcpAgents({ agents: [{ id: "devin", name: "Devin", version: "1.0", description: "d", website: "https://x.test", icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg" }, { name: "bad" }] });
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ id: "devin", distribution: "npx", website: "https://x.test", repository: null });
});

test("a prepare result replaces the agent's id, version and distribution", () => {
  const agent = readAcpAgents({ agents: [{ id: "a", name: "A", version: "1", distribution: "npx" }] })[0] as any;
  expect(applyPrepareResult(agent, { agentId: "a-2", version: "2.0.0", distribution: "binary", prepared: true })).toMatchObject({ id: "a-2", version: "2.0.0", distribution: "binary" });
  expect(applyPrepareResult(agent, null)).toBe(agent);
});

test("only registry-sourced acpRegistry instances count as already added", () => {
  const instances = { one: { driver: "acpRegistry", config: { agentId: "devin" } }, two: { driver: "acpRegistry", config: { source: "local", agentId: "x" } }, three: { driver: "codex", config: { agentId: "y" } } };
  expect(isConfiguredAcpRegistryAgent(instances, "devin")).toBe(true);
  expect(isConfiguredAcpRegistryAgent(instances, "x")).toBe(false);
  expect(isConfiguredAcpRegistryAgent(instances, "y")).toBe(false);
});

test("only the official CDN's icons load", () => {
  expect(officialAcpIconUrl("https://cdn.agentclientprotocol.com/registry/v1/latest/a.svg")).not.toBeNull();
  expect(officialAcpIconUrl("https://evil.test/a.svg")).toBeNull();
  expect(officialAcpIconUrl("http://cdn.agentclientprotocol.com/a.svg")).toBeNull();
  expect(officialAcpIconUrl(null)).toBeNull();
});

test("moving past Provider needs an agent, and past Identity needs a valid id", () => {
  expect(resolveAcpNavigation(0, 1, { instanceIdError: null, selectionError: "Select an ACP or configure one manually.", local: false })).toEqual({ kind: "blocked", step: 0, error: "Select an ACP or configure one manually." });
  expect(resolveAcpNavigation(0, 1, { instanceIdError: "bad", selectionError: null, local: false })).toEqual({ kind: "navigate", step: 1 });
  expect(resolveAcpNavigation(1, 2, { instanceIdError: "bad", selectionError: null, local: false })).toEqual({ kind: "blocked", step: 1, error: "bad" });
  expect(resolveAcpNavigation(1, 5, { instanceIdError: null, selectionError: null, local: true })).toEqual({ kind: "navigate", step: 1 });
});
