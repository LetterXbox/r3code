import { expect, test } from "nsh/test";
import { appSignInTargetForRemote, parseRemote, suggestAppAccessForRemote } from "./appAccess";
import { clearToasts, toasts } from "../../toast/toastState";

test("remotes parse as host and lower-cased path, in https, ssh and scp forms", () => {
  expect(parseRemote("https://github.com/Octo/Repo.git")).toEqual({ host: "github.com", path: "octo/repo" });
  expect(parseRemote("git@github.com:Octo/Repo.git")).toEqual({ host: "github.com", path: "octo/repo" });
  expect(parseRemote("ssh://git@gitlab.com/group/sub/project")).toEqual({ host: "gitlab.com", path: "group/sub/project" });
  expect(parseRemote("not a remote")).toBe(null);
});

test("only a host with an app sign-in has a target, and the repository keeps its own casing", () => {
  expect(appSignInTargetForRemote("https://github.com/Octo/Repo.git")?.input).toEqual({ provider: "github", host: "github.com", repository: "Octo/Repo" });
  expect(appSignInTargetForRemote("https://gitlab.com/octo/repo.git")).toBe(null);
});

test("a repository the app does not reach raises the install toast; covered, signed out and a failing check stay quiet", async () => {
  clearToasts();
  const calls: unknown[] = [];
  const answer = (status: string) => async (method: string, payload: unknown) => { calls.push([method, payload]); return { status }; };
  await suggestAppAccessForRemote(answer("covered"), "https://github.com/octo/repo.git");
  await suggestAppAccessForRemote(answer("signed-out"), "https://github.com/octo/repo.git");
  await suggestAppAccessForRemote(async () => { throw new Error("offline"); }, "https://github.com/octo/repo.git");
  await suggestAppAccessForRemote(answer("not-covered"), "https://gitlab.com/octo/repo.git");
  expect(toasts()).toHaveLength(0);
  await suggestAppAccessForRemote(answer("not-covered"), "https://github.com/octo/repo.git");
  expect(calls[calls.length - 1]).toEqual(["sourceControl.appAccess", { provider: "github", host: "github.com", repository: "octo/repo" }]);
  expect(toasts()).toHaveLength(1);
  expect(toasts()[0]!.title).toBe("Give T3 Code for GitHub access to octo");
  expect(toasts()[0]!.actions.map((action) => action.label)).toEqual(["Install"]);
  clearToasts();
});
