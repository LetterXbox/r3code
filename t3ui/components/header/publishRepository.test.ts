import { expect, test } from "nsh/test";
import {
  canSubmitPublish, publishHostFor, publishProviderReadiness, publishRepository, publishRepositoryPrefill, publishSummaryCopy, readPublishDiscovery, resolvePublishProvider,
  sortPublishProviders, splitRepository,
} from "./publishRepository";

// Contract-shaped: server.discoverSourceControl carries effect Options over the wire.
const wire = {
  versionControlSystems: [],
  sourceControlProviders: [
    { kind: "github", label: "GitHub", status: "available", installHint: "", auth: { status: "authenticated", account: { _tag: "Some", value: "me" }, host: { _tag: "Some", value: "github.com" }, detail: { _tag: "None" } } },
    { kind: "gitlab", label: "GitLab", status: "missing", installHint: "Install glab.", auth: { status: "unknown", account: { _tag: "None" }, host: { _tag: "None" }, detail: { _tag: "None" } } },
    { kind: "bitbucket", label: "Bitbucket", status: "available", installHint: "", auth: { status: "unauthenticated", account: null, host: null, detail: "Run bb login." } },
    { kind: "forgejo", label: "Forgejo", status: "available", installHint: "", auth: { status: "authenticated", account: "ann", host: "git.example.com", detail: null } },
  ],
};
const discovered = readPublishDiscovery(wire);

test("discovery is read from effect Options and bare values", () => {
  expect(discovered.map((item) => item.kind)).toEqual(["github", "gitlab", "bitbucket", "forgejo"]);
  expect(discovered[0]!.auth).toEqual({ status: "authenticated", account: "me", host: "github.com", detail: null });
  expect(discovered[2]!.auth.detail).toBe("Run bb login.");
});

test("readiness names why a provider cannot be used", () => {
  expect(publishProviderReadiness("github", discovered)).toEqual({ ready: true, hint: null });
  expect(publishProviderReadiness("gitlab", discovered)).toEqual({ ready: false, hint: "Install glab." });
  expect(publishProviderReadiness("bitbucket", discovered).hint).toBe("Run bb login.");
  expect(publishProviderReadiness("azure-devops", discovered).hint).toBe("Provider status unavailable. Open Settings -> Source control and rescan.");
  expect(publishProviderReadiness("github", []).ready).toBe(false);
});

test("ready providers sort first, by label, and the chosen one is kept only while ready", () => {
  expect(sortPublishProviders(discovered).map((option) => option.kind).slice(0, 2)).toEqual(["forgejo", "github"]);
  expect(resolvePublishProvider(null, discovered)).toBe("forgejo");
  expect(resolvePublishProvider("github", discovered)).toBe("github");
  expect(resolvePublishProvider("gitlab", discovered)).toBe("forgejo");
  expect(resolvePublishProvider(null, [])).toBe("github");
});

test("the repository field is prefilled with the account and the host comes from the provider", () => {
  expect(publishRepositoryPrefill("github", discovered)).toBe("me/");
  expect(publishRepositoryPrefill("gitlab", discovered)).toBe("");
  expect(publishHostFor("github", discovered)).toBe("github.com");
  expect(publishHostFor("forgejo", discovered)).toBe("git.example.com");
  expect(publishHostFor("forgejo", [])).toBe("your server");
});

test("a repository needs an owner and a name", () => {
  expect(splitRepository(" me / app/x ")).toEqual({ owner: "me", name: "app/x" });
  expect(canSubmitPublish({ allowed: true, ready: true, pending: false, repository: "me/" })).toBe(false);
  expect(canSubmitPublish({ allowed: true, ready: true, pending: false, repository: "me/app" })).toBe(true);
  expect(canSubmitPublish({ allowed: false, ready: true, pending: false, repository: "me/app" })).toBe(false);
  expect(canSubmitPublish({ allowed: true, ready: true, pending: true, repository: "me/app" })).toBe(false);
});

test("publishing sends the contract's input and reads its result", async () => {
  const calls: unknown[] = [];
  const result = await publishRepository("/repo", { provider: "github", repository: " me/app ", visibility: "private", remoteName: " ", protocol: "https" }, async (method, payload) => {
    calls.push([method, payload]);
    return { repository: { provider: "github", nameWithOwner: "me/app", url: "https://github.com/me/app", sshUrl: "x" }, remoteName: "origin", remoteUrl: "u", branch: "main", status: "remote_added" };
  });
  expect(calls).toEqual([["sourceControl.publishRepository", { cwd: "/repo", provider: "github", repository: "me/app", visibility: "private", remoteName: "origin", protocol: "https" }]]);
  expect(result.status).toBe("remote_added");
  expect(publishSummaryCopy(result, "GitHub")).toEqual({ title: "Repository created", body: 'Remote "origin" is set up. Make a commit and push it to share your code.' });
  expect(publishSummaryCopy({ ...result, status: "pushed" }, "GitHub")).toEqual({ title: "Repository published", body: "main is now live on GitHub." });
});

test("an invalid publish result is an error", async () => {
  let message = "";
  await publishRepository("/repo", { provider: "github", repository: "me/app", visibility: "private", remoteName: "origin", protocol: "ssh" }, async () => ({})).catch((cause: Error) => { message = cause.message; });
  expect(message).toBe("The server returned an invalid publish result.");
});

test("a published repository on GitHub is checked for the app's access, as after a clone", async () => {
  const calls: string[] = [];
  await publishRepository("/repo", { provider: "github", repository: "me/app", visibility: "private", remoteName: "origin", protocol: "ssh" }, async (method) => {
    calls.push(method);
    return { repository: { provider: "github", nameWithOwner: "me/app", url: "https://github.com/me/app", sshUrl: "x" }, remoteName: "origin", remoteUrl: "git@github.com:me/app.git", branch: "main", status: "pushed" };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual(["sourceControl.publishRepository", "sourceControl.appAccess"]);
});
