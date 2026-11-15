import { expect, test } from "nsh/test";
import { runOutdatedHostUpdate, updateOutdatedHost, type OutdatedHostDeps } from "./outdatedHostUpdate";

const v1 = { environmentId: "e1", label: "box", serverVersion: "0.1.0", orchestrationProtocolVersion: 1, capabilities: { serverSelfUpdate: "respawn" } };
const v2 = { ...v1, serverVersion: "0.1.8", orchestrationProtocolVersion: 2 };

function host(descriptors: (Record<string, unknown> | null)[]) {
  const calls: string[] = [];
  let clock = 0;
  const deps: OutdatedHostDeps = {
    open: async () => ({ request: async (method) => { calls.push(method); return { targetVersion: "0.1.8", method: "respawn" }; }, subscribe: () => () => {}, close: () => calls.push("close") }),
    descriptor: async () => descriptors.shift() ?? null,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { calls, deps };
}

test("an outdated host updates over a bare socket and resolves once it answers on a compatible protocol", async () => {
  const h = host([v1, null, v1, v2]);
  const stages: string[] = [];
  expect(await updateOutdatedHost({ endpoint: "ws://x", bearer: "b", descriptor: v1, targetVersion: "0.1.8" }, (s) => stages.push(s), h.deps)).toEqual({ targetVersion: "0.1.8" });
  expect(h.calls).toEqual(["server.updateServer", "close"]);
  expect(stages.at(-1)).toBe("resuming");
});

test("a host that cannot update itself, or never comes back, fails with the reference copy", async () => {
  let message = "";
  await updateOutdatedHost({ endpoint: "ws://x", bearer: "b", descriptor: { ...v1, capabilities: {} }, targetVersion: "0.1.8" }, () => {}, host([v1]).deps).catch((e: Error) => { message = e.message; });
  expect(message).toBe("Update T3 Code on box manually; it cannot update itself.");
  await updateOutdatedHost({ endpoint: "ws://x", bearer: "b", descriptor: v1, targetVersion: "0.1.8" }, () => {}, host([v1]).deps).catch((e: Error) => { message = e.message; });
  expect(message).toBe("box did not come back on a compatible T3 Code version.");
});

test("an already-compatible host skips the update; the run toasts and reconnects", async () => {
  const h = host([v2]);
  const toasts: string[] = [];
  let reconnected = false;
  await runOutdatedHostUpdate({ key: "k", serverLabel: "box server", endpoint: "ws://x", bearer: "b", descriptor: v1, targetVersion: "0.1.8" }, { toast: (t) => toasts.push(`${t.type}:${t.title}:${t.description}`), reconnect: () => { reconnected = true; } }, h.deps);
  expect(h.calls).toEqual([]);
  expect(toasts).toEqual(["success:box server updated:Reconnected on t3@0.1.8."]);
  expect(reconnected).toBe(true);
});
