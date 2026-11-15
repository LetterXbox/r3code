// ui/autocomplete.tsx behaviour: open on focus, arrows highlight (looping), Enter / Mod+N / press pick, Escape closes.
import { expect, open, test } from "nsh/test";
import { moveHighlight } from "./Autocomplete";
import { filterDiscoveredSshHosts, unsavedSshHosts } from "../pages/settings/Connection";

test("moveHighlight loops and starts from either end", () => {
  expect(moveHighlight(-1, 3, "down")).toBe(0);
  expect(moveHighlight(-1, 3, "up")).toBe(2);
  expect(moveHighlight(2, 3, "down")).toBe(0);
  expect(moveHighlight(0, 0, "down")).toBe(-1);
});

test("filterDiscoveredSshHosts: alias prefixes first, then alias or hostname substrings", () => {
  const hosts = [{ alias: "my-dev", hostname: "10.0.0.2" }, { alias: "devbox", hostname: "dev.example.com" }, { alias: "prod", hostname: "devops.example.com" }];
  expect(filterDiscoveredSshHosts(hosts, " Dev ").map((host) => host.alias)).toEqual(["devbox", "my-dev", "prod"]);
  expect(filterDiscoveredSshHosts(hosts, "").length).toBe(3);
});

test("the field opens the list; arrows and Enter pick, Escape closes, Mod+3 picks the third row", async () => {
  const app = await open("./AutocompleteFixture.tsx");
  await app.type("label:Host", "");
  await app.waitFor("text:picked=none open=true highlighted=-1");
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.waitFor("text:picked=none open=true highlighted=1");
  await app.keyboard.press("enter");
  await app.waitFor("text:picked=gpu-box open=false highlighted=1");
  await app.type("label:Host", "s");
  await app.waitFor("text:/open=true/");
  await app.keyboard.press("escape");
  await app.waitFor("text:/open=false/");
  await app.clear("label:Host");
  await app.type("label:Host", "");
  await app.keyboard.press("mod+3");
  await app.waitFor("text:/picked=staging/");
});

test("unsavedSshHosts: a saved SSH environment's alias, or a known-hosts address it uses, is not offered", () => {
  const hosts = [
    { alias: "devbox", hostname: "10.0.0.2", username: null, port: null, source: "ssh-config" },
    { alias: "gpu", hostname: "gpu.lan", username: null, port: null, source: "ssh-config" },
    { alias: "gpu.lan", hostname: "gpu.lan", username: null, port: null, source: "known-hosts" },
    { alias: "other.lan", hostname: "other.lan", username: null, port: null, source: "known-hosts" },
  ];
  const saved = [{ ssh: { target: { alias: "devbox", hostname: "10.0.0.2", username: null, port: null } } }, { ssh: { target: { alias: "gpu.lan", hostname: "gpu.lan", username: null, port: null } } }, {}];
  expect(unsavedSshHosts(hosts, saved).map((host) => host.alias)).toEqual(["gpu", "other.lan"]);
});
