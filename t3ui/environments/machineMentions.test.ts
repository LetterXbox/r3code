import { expect, test } from "nsh/test";
import { offersLinkedEnvironments } from "./machineMentions";
import { environmentMentionItems } from "../components/composer/commandItems";
import { environmentContextRecord } from "../components/composer/contextChips";

test("@ machine mentions: offered with peer links and the beta on, other machines only, by label", () => {
  expect(offersLinkedEnvironments({ environment: { capabilities: { peerLinks: true } }, settings: { linkedEnvironmentsEnabled: true } })).toBe(true);
  expect(offersLinkedEnvironments({ environment: { capabilities: { peerLinks: true } }, settings: { linkedEnvironmentsEnabled: false } })).toBe(false);
  expect(offersLinkedEnvironments(null)).toBe(false);
  const machines = [{ environmentId: "env-a", label: "Studio", machine: "laptop" as const }, { environmentId: "env-b", label: "Build box", machine: "server" as const }];
  expect(environmentMentionItems(machines, { environmentId: "env-a", query: "" })).toEqual([]);
  expect(environmentMentionItems(machines, { environmentId: "env-a", query: "b" })).toEqual([{ id: "environment:env-b", type: "environment", environmentId: "env-b", machine: "server", label: "Build box", description: "Machine" }]);
  expect(environmentContextRecord("env-b", "Build [box]")).toEqual({ version: 1, kind: "environment", contextId: "environment_env-b", label: "Build box", environmentId: "env-b" });
});

test("a pasted machine chip brings its environment record into the other draft", async () => {
  const { attachExtraContext, attachedExtraContexts, extraContextMarker, restorePastedContexts } = await import("../components/composer/contextChips");
  const record = environmentContextRecord("env-b", "Build box");
  attachExtraContext("draft-a", record);
  expect(restorePastedContexts("draft-b", `run it on ${extraContextMarker(record)}`)).toBe(1);
  expect(attachedExtraContexts("draft-b").map((item) => item.kind)).toEqual(["environment"]);
});

test("thread mentions: this machine's and linked machines' threads, named by machine", async () => {
  const { threadMentionItems } = await import("../components/composer/commandItems");
  const { linkedEnvironmentNames } = await import("./linkedEnvironments");
  const linked = linkedEnvironmentNames({ links: [{ environmentId: "env-b", label: "b-link" }, { environmentId: "env-c", label: "c", status: "expired" }], environments: [{ environmentId: "env-b", label: "Build box" }] });
  expect([...linked.entries()]).toEqual([["env-b", "Build box"]]);
  const threads = [
    { id: "t1", title: "login here", updatedAt: 3, machineEnvironmentId: "env-a" },
    { id: "saved:x:t2", title: "login there", updatedAt: 2, machineEnvironmentId: "env-b", localId: "t2" },
    { id: "saved:y:t3", title: "login elsewhere", updatedAt: 1, machineEnvironmentId: "env-z", localId: "t3" },
  ];
  const items = threadMentionItems(threads, { environmentId: "env-a", excludeThreadId: undefined, query: "login", linkedEnvironments: linked });
  expect(items.map((item) => [item.id, item.description])).toEqual([["thread:env-a:t1", "Thread"], ["thread:env-b:t2", "Thread on Build box"]]);
});
