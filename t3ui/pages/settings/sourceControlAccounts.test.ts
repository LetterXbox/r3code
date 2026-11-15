import { expect, test } from "nsh/test";
import { accountPatch, groupHostAccounts, hasToken, nextHostAccountChoices, readHostCredentialSettings, tokenPatch } from "./sourceControlAccounts";

const accounts = [
  { host: "github.com", account: "ada", active: true, authenticated: true },
  { host: "github.com", account: "bob", active: false, authenticated: true },
  { host: "github.com", account: "old", active: false, authenticated: false, error: "expired" },
  { host: "ghe.example", account: "env", active: true, authenticated: true, environmentVariable: "GH_TOKEN" },
];

test("accounts group by host: selectable logins, broken ones, and a token variable that overrides", () => {
  const [github, ghe] = groupHostAccounts(accounts);
  expect(github).toEqual({ host: "github.com", activeAccount: "ada", selectable: ["ada", "bob"], broken: [accounts[2]], environmentVariable: null });
  expect(ghe.environmentVariable).toBe("GH_TOKEN");
  expect(ghe.selectable).toEqual([]);
});

test("choosing an account keeps the other hosts, and the default choice leaves no entry", () => {
  const pinned = nextHostAccountChoices({}, "github.com", { account: "bob" });
  expect(pinned).toEqual({ "github.com": { enabled: true, account: "bob" } });
  expect(nextHostAccountChoices(pinned, "github.com", { account: null })).toEqual({});
  expect(nextHostAccountChoices(pinned, "github.com", { enabled: false })).toEqual({ "github.com": { enabled: false, account: "bob" } });
  expect(nextHostAccountChoices(pinned, "ghe.example", { enabled: false })["github.com"]).toEqual({ enabled: true, account: "bob" });
});

test("saved choices and tokens are read from the server's sourceControlHosts", () => {
  const settings = { sourceControlHosts: { github: { hosts: { "github.com": { enabled: false, account: "ada" } }, tokens: { "github.com": "redacted" } } } };
  expect(readHostCredentialSettings(settings, "github")).toEqual({ hosts: { "github.com": { enabled: false, account: "ada" } }, tokens: { "github.com": "redacted" } });
  expect(readHostCredentialSettings(null, "github")).toEqual({ hosts: {}, tokens: {} });
  expect(hasToken("")).toBe(false);
  expect(hasToken("redacted")).toBe(true);
});

test("a token is saved with the whole map so other hosts keep their values", () => {
  expect(tokenPatch("github", { "ghe.example": "marker" }, "github.com", "ghp_x")).toEqual({
    sourceControlHosts: { github: { tokens: { "ghe.example": "marker", "github.com": "ghp_x" } } },
  });
  expect(accountPatch("github", {})).toEqual({ sourceControlHosts: { github: { hosts: {} } } });
});
