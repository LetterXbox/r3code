import { expect, test } from "nsh/test";
import { isClearComposerCommand, parseSideChatCommand } from "./composerTrigger";
import { parsePullRequests, pullRequestItems, searchSlashCommands, skillMenuItems, slashMenuItems, userInvocableSkills } from "./commandItems";
import { parseCommands, parseSkills } from "./providerCatalog";
import { parseUsageLimits } from "./usageLimitsLogic";

const commands = parseCommands([
  { name: "compact", description: "Summarize the conversation" },
  { name: "review", input: { hint: "[pr]" } },
  { name: "init" },
  { description: "nameless" },
]);
const skills = parseSkills([
  { name: "review", path: "/s/review", scope: "user", enabled: true, shortDescription: "Review a diff" },
  { name: "review", path: "/s/review2", enabled: true },
  { name: "hidden", path: "/s/hidden", enabled: true, userInvocable: false },
  { name: "off", path: "/s/off", enabled: false },
  { name: "deploy", displayName: "Deploy app", path: "/s/deploy", enabled: true, description: "Ship it" },
]);

test("provider commands and skills parse from the server snapshot and skip malformed rows", () => {
  expect(commands.map((item) => item.name)).toEqual(["compact", "review", "init"]);
  expect(commands[1]!.inputHint).toBe("[pr]");
  expect(userInvocableSkills(skills).map((skill) => skill.name)).toEqual(["review", "deploy"]);
});

test("the slash menu lists /model, provider commands that no skill covers, then skills", () => {
  const items = slashMenuItems({ commands, skills, provider: "claude", showSkills: true, atPromptStart: true, compactAvailable: true });
  expect(items.map((item) => item.label)).toEqual(["/model", "/compact", "/init", "/skill:review", "/skill:deploy"]);
  expect(items.find((item) => item.label === "/compact")?.description).toBe("Summarize the conversation");
  const later = slashMenuItems({ commands, skills, provider: "claude", showSkills: true, atPromptStart: false });
  expect(later.map((item) => item.label)).toEqual(["/model", "/skill:review", "/skill:deploy"]);
  expect(slashMenuItems({ commands, skills, provider: "claude", showSkills: false, atPromptStart: true, compactAvailable: true }).map((item) => item.label)).toEqual(["/model", "/compact", "/review", "/init"]);
});

test("slash search ranks names first and finds skills by their display name", () => {
  const items = slashMenuItems({ commands, skills, provider: "claude", showSkills: true, atPromptStart: true, compactAvailable: true });
  expect(searchSlashCommands(items, "com")[0]?.label).toBe("/compact");
  expect(searchSlashCommands(items, "skill:dep").map((item) => item.label)).toEqual(["/skill:deploy"]);
  expect(searchSlashCommands(items, "").length).toBe(items.length);
});

test("the dollar menu lists skills by display name and filters by query", () => {
  expect(skillMenuItems(skills, "claude", "").map((item) => item.label)).toEqual(["Deploy app", "review"]);
  expect(skillMenuItems(skills, "claude", "ship").map((item) => item.label)).toEqual(["Deploy app"]);
});

test("the hash menu lists this repository's pull requests by number or title", () => {
  const entries = parsePullRequests({ entries: [
    { number: 12, title: "Fix the queue", url: "u", repository: "o/r", projectId: "p", headBranch: "fix", baseBranch: "main", state: "open" },
    { number: 30, title: "Other repo", url: "u", repository: "x/y", projectId: "p" },
    { number: "bad" },
  ] });
  expect(entries.length).toBe(2);
  expect(pullRequestItems(entries, "o/r", "").map((item) => item.label)).toEqual(["#12"]);
  expect(pullRequestItems(entries, "o/r", "queue").length).toBe(1);
  expect(pullRequestItems(entries, "o/r", "99")).toEqual([]);
});

test("/usage-limits is offered only when the provider snapshot reports limits, and parses the windows", () => {
  const without = slashMenuItems({ commands, skills: [], provider: "claude", showSkills: true, atPromptStart: true });
  expect(without.some((item) => item.label === "/usage-limits")).toBe(false);
  const withLimits = slashMenuItems({ commands, skills: [], provider: "claude", showSkills: true, atPromptStart: true, usageLimitsOffered: true });
  expect(withLimits.find((item) => item.label === "/usage-limits")?.description).toBe("Show this provider's usage limits");
  expect(parseUsageLimits(null)).toBe(null);
  expect(parseUsageLimits({ windows: [], unavailable: { reason: "unsupported" } })?.notice).toBe("This account has no subscription limits.");
  expect(parseUsageLimits({ windows: [] })?.notice).toBe("No limits reported.");
  expect(parseUsageLimits({ windows: [{ id: "a", label: "A", usedPercent: 10 }] })?.notice).toBe(null);
});

test("/side, /btw and /clear appear only where they can run, and /compact only while the thread can be compacted", () => {
  const base = { commands, skills: [], provider: "claude", showSkills: true, atPromptStart: true } as const;
  expect(slashMenuItems(base).map((item) => item.label)).toEqual(["/model", "/review", "/init"]);
  const all = slashMenuItems({ ...base, sideChatAvailable: true, freshSessionAvailable: true, compactAvailable: true });
  expect(all.map((item) => item.label)).toEqual(["/model", "/side", "/btw", "/clear", "/compact", "/review", "/init"]);
  expect(all.find((item) => item.label === "/side")?.description).toBe("Ask a side question in a new side chat");
  expect(all.find((item) => item.label === "/btw")?.description).toBe("Same as /side");
  expect(all.find((item) => item.label === "/clear")?.description).toBe("Start a fresh session; earlier messages stay visible");
  const blocked = slashMenuItems({ ...base, sideChatAvailable: true, sideChatDisabledReason: "Side chats start after the first message." });
  expect(blocked.find((item) => item.label === "/side")?.description).toBe("Side chats start after the first message.");
  // The provider's own /clear is hidden when T3's fresh-session /clear replaces it.
  const provider = parseCommands([{ name: "clear", description: "Clear" }]);
  expect(slashMenuItems({ ...base, commands: provider, freshSessionAvailable: true }).filter((item) => item.label === "/clear").length).toBe(1);
  expect(slashMenuItems({ ...base, commands: provider, freshSessionAvailable: false }).filter((item) => item.label === "/clear").length).toBe(1);
});

test("/clear and /side are recognised only as the whole message", () => {
  expect(isClearComposerCommand("/clear")).toBe(true);
  expect(isClearComposerCommand("  /CLEAR \n")).toBe(true);
  expect(isClearComposerCommand("/clear now")).toBe(false);
  expect(parseSideChatCommand("/side why is this slow?")).toEqual({ prompt: "why is this slow?" });
  expect(parseSideChatCommand("/btw")).toEqual({ prompt: "" });
  expect(parseSideChatCommand("tell me /side")).toBe(null);
});

test("a typed /usage-limits is recognised whatever its case and padding (isUsageLimitsCommand)", async () => {
  const { isUsageLimitsCommand } = await import("./commandItems");
  expect(isUsageLimitsCommand("  /Usage-Limits ")).toBe(true);
  expect(isUsageLimitsCommand("/usage-limits now")).toBe(false);
});
