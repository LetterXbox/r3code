import { expect, test } from "nsh/test";
import { buildRemoteOpenUrl, openFolderInEditor, resolveRemoteOpenState } from "./remoteOpen";

test("fm13: buildRemoteOpenUrl matches the contract for VS Code, Zed and JetBrains", () => {
  expect(buildRemoteOpenUrl({ editor: "vscode", host: "box.tail", username: "me", absolutePath: "/srv/my app", isFile: true })).toBe("vscode://vscode-remote/ssh-remote%2Bme%40box.tail/srv/my%20app:1:1".replace("%2B", "+"));
  expect(buildRemoteOpenUrl({ editor: "zed", host: "box", absolutePath: "/srv/a" })).toBe("zed://ssh/box/srv/a");
  expect(buildRemoteOpenUrl({ editor: "goland", host: "box", absolutePath: "/srv/a" })).toBe("jetbrains://gateway/ssh/environment?h=box&launchIde=true&ideHint=GO&projectHint=%2Fsrv%2Fa");
  expect(buildRemoteOpenUrl({ editor: "trae", host: "box", absolutePath: "/a" })).toBeUndefined();
});

test("fm13: a local thread launches; a remote one opens its link or reports no route", async () => {
  expect(resolveRemoteOpenState(null, null)).toEqual({ mode: "local-exec" });
  expect(resolveRemoteOpenState("env", { remoteOpenTargets: [{ kind: "tailscale", host: "box.ts.net" }] })).toEqual({ mode: "remote-links", host: { kind: "tailscale", host: "box.ts.net" } });
  expect(resolveRemoteOpenState("env", {})).toEqual({ mode: "remote-unavailable" });
  const opened: string[] = [];
  let launched = 0;
  const base = { cwd: "/srv/a", editor: "cursor", launchLocal: async () => { launched += 1; }, openUrl: async (url: string) => { opened.push(url); } };
  await openFolderInEditor({ ...base, environmentId: null, config: null });
  expect(launched).toBe(1);
  await openFolderInEditor({ ...base, environmentId: "env", config: { remoteOpenTargets: [{ kind: "mdns", host: "box.local" }] } });
  expect(opened).toEqual(["cursor://vscode-remote/ssh-remote+box.local/srv/a"]);
  let message = "";
  await openFolderInEditor({ ...base, environmentId: "env", environmentLabel: "Lab", config: {} }).catch((error: Error) => { message = error.message; });
  expect(message).toBe("No SSH route to Lab");
});
