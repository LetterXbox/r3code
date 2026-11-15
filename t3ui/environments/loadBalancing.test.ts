import { expect, test } from "nsh/test";
import { chooseLoadBalancedEnvironment } from "./loadBalancing";

const host = (cpuUtilization: number | null, cpuCount = 8, available = 8, total = 16) => ({ cpuCount, cpuUtilization, availableMemoryBytes: available, totalMemoryBytes: total });

test("the freest machine wins, weighted by preference", () => {
  const now = 100_000;
  expect(chooseLoadBalancedEnvironment([
    { environmentId: "a", resources: host(0.8), receivedAt: now, weight: 50 },
    { environmentId: "b", resources: host(0.2), receivedAt: now, weight: 50 },
  ], now)).toBe("b");
  expect(chooseLoadBalancedEnvironment([
    { environmentId: "a", resources: host(0.5), receivedAt: now, weight: 100 },
    { environmentId: "b", resources: host(0.4), receivedAt: now, weight: 25 },
  ], now)).toBe("a");
});

test("stale, busy, starved, manual-only and unknown hosts are skipped", () => {
  const now = 100_000;
  expect(chooseLoadBalancedEnvironment([{ environmentId: "a", resources: host(0.1), receivedAt: now - 16_000, weight: 50 }], now)).toBeNull();
  expect(chooseLoadBalancedEnvironment([{ environmentId: "a", resources: host(0.96), receivedAt: now, weight: 50 }], now)).toBeNull();
  expect(chooseLoadBalancedEnvironment([{ environmentId: "a", resources: host(0.1, 8, 0, 16), receivedAt: now, weight: 50 }], now)).toBeNull();
  expect(chooseLoadBalancedEnvironment([{ environmentId: "a", resources: host(0.1), receivedAt: now, weight: 0 }], now)).toBeNull();
  expect(chooseLoadBalancedEnvironment([{ environmentId: "a", resources: host(null), receivedAt: now, weight: 50 }], now)).toBeNull();
  expect(chooseLoadBalancedEnvironment([{ environmentId: "a", resources: null, weight: 50 }], now)).toBeNull();
});

test("the move step reads each machine's host resources and picks the freest checkout; failed reads report unavailable", async () => {
  const { pickLoadBalancedProject } = await import("./loadBalancing");
  const calls: string[] = [];
  const machine = (name: string, cpuUtilization: number | null, fail = false) => async (method: string) => {
    calls.push(`${name} ${method}`);
    if (fail) throw new Error("offline");
    return { sampledAt: 0, cpuCount: 8, cpuUtilization, availableMemoryBytes: 8, totalMemoryBytes: 16 };
  };
  const project = (id: string) => ({ id, name: id, threads: [] }) as never;
  const picked = await pickLoadBalancedProject([
    { member: project("mac"), request: machine("mac", 0.9), weight: 50 },
    { member: project("box"), request: machine("box", 0.1), weight: 50 },
  ], () => 1000);
  expect(calls.sort()).toEqual(["box server.getHostResources", "mac server.getHostResources"]);
  expect((picked.chosen as { id: string } | null)?.id).toBe("box");
  expect(picked.failed).toBe(false);
  const down = await pickLoadBalancedProject([
    { member: project("mac"), request: machine("mac", 0, true), weight: 50 },
    { member: project("box"), request: machine("box", 0, true), weight: 50 },
  ], () => 1000);
  expect(down).toEqual({ chosen: null, failed: true });
  expect(await pickLoadBalancedProject([{ member: project("mac"), request: machine("mac", 0.1), weight: 50 }])).toEqual({ chosen: null, failed: false });
});

test("loadBalancingSendWarning copy", async () => {
  const { loadBalancingSendWarning } = await import("./loadBalancing");
  expect(loadBalancingSendWarning({ pending: true, threadContextEnvironmentIds: [], candidateEnvironmentIds: [] }).title).toBe("Checking machine resources");
  expect(loadBalancingSendWarning({ pending: false, threadContextEnvironmentIds: [], candidateEnvironmentIds: ["a"] }).description).toBe("No eligible machine has available resources. Choose a machine in the composer to override.");
  expect(loadBalancingSendWarning({ pending: false, threadContextEnvironmentIds: ["a", "b"], candidateEnvironmentIds: ["a", "b"] }).description).toBe("No machine can read every attached thread. Choose a machine in the composer or remove the threads.");
});
