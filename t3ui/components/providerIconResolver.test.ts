import { expect, test } from "nsh/test";
import { resolveAcpRegistryBranding } from "./providerIconResolver";

test("an ACP registry instance takes the snapshot icon, settings branding over it, and none when local (applyProviderInstanceBranding)", () => {
  const providers = [{ instanceId: "acp_a", driver: "acpRegistry", iconUrl: "https://cdn/a.svg" }, { instanceId: "codex", driver: "codex", iconUrl: "https://x" }];
  expect(resolveAcpRegistryBranding("acp_a", providers, {})).toEqual({ iconUrl: "https://cdn/a.svg" });
  expect(resolveAcpRegistryBranding("codex", providers, {})).toEqual({});
  expect(resolveAcpRegistryBranding("acp_a", providers, { providerInstances: { acp_a: { config: { agentId: " gem ", registryIconUrl: "https://cdn/b.svg" } } } })).toEqual({ agentId: "gem", iconUrl: "https://cdn/b.svg" });
  expect(resolveAcpRegistryBranding("acp_a", providers, { providerInstances: { acp_a: { config: { source: "local" } } } })).toEqual({});
});

test("registry artwork must be the official CDN; an agent id alone gives its CDN icon (resolveProviderInstanceAcpRegistryIconUrl)", async () => {
  const { resolveAcpRegistryIconUrl, resolveOfficialAcpRegistryIconUrl, officialAcpRegistryIconUrlForAgentId } = await import("./providerIconResolver");
  expect(resolveOfficialAcpRegistryIconUrl("https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg")).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg");
  expect(resolveOfficialAcpRegistryIconUrl("http://cdn.agentclientprotocol.com/x.svg")).toBe(null);
  expect(resolveOfficialAcpRegistryIconUrl("https://evil.example/x.svg")).toBe(null);
  expect(resolveOfficialAcpRegistryIconUrl("https://u:p@cdn.agentclientprotocol.com/x.svg")).toBe(null);
  expect(officialAcpRegistryIconUrlForAgentId("Bad Id")).toBe(null);
  expect(resolveAcpRegistryIconUrl({ agentId: "gemini", iconUrl: "https://evil.example/x.svg" })).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg");
  expect(resolveAcpRegistryIconUrl({})).toBe(null);
});
