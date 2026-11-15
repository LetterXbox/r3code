import { expect, test } from "nsh/test";
import { MCP_APPS, mcpHandoffAction } from "./mcpApps";

const MCP_URL = "https://prod-a1.t3coderelay.com/mcp?x=1&y=two words";

test("MCP app links fill in R3 Code and the encoded URL", () => {
  const opened = (id: string) => new URL(mcpHandoffAction(MCP_APPS.find((candidate) => candidate.id === id)!, MCP_URL)!.link);
  const poke = opened("poke");
  expect(poke.searchParams.get("name")).toBe("T3 Code");
  expect(poke.searchParams.get("url")).toBe(MCP_URL);
  const claude = opened("claude");
  expect(claude.searchParams.get("connectorName")).toBe("T3 Code");
  expect(claude.searchParams.get("connectorUrl")).toBe(MCP_URL);
});

test("every MCP app opens only https links, and the grid hides Gemini", () => {
  for (const app of MCP_APPS) {
    const link = mcpHandoffAction(app, MCP_URL)?.link;
    for (const url of [link, app.docs].filter((value): value is string => value != null)) expect(new URL(url).protocol).toBe("https:");
  }
  expect(MCP_APPS.filter((app) => !app.hidden).map((app) => app.name)).toEqual(["Poke", "Claude", "ChatGPT", "Grok Bot", "Muse", "Instinct", "OpenClaw", "Hermes Agent"]);
  expect(mcpHandoffAction(MCP_APPS.find((app) => app.id === "chatgpt")!, MCP_URL)).toEqual({ label: "Copy URL and open ChatGPT", link: "https://chatgpt.com/plugins", copy: { text: MCP_URL, title: "URL copied" } });
  expect(mcpHandoffAction(MCP_APPS.find((app) => app.id === "openclaw")!, MCP_URL)).toBeNull();
});
