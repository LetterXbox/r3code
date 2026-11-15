import { expect, test } from "nsh/test";
import { clearToasts, toastById } from "../toast/toastState";
import {
  LONG_RUNNING_RPC_ACK_THRESHOLD_MS,
  SLOW_RPC_ACK_THRESHOLD_MS,
  SLOW_RPC_TOAST_ID,
  acknowledgeRpcRequest,
  describeSlowRequests,
  rpcAckThresholdMs,
  setSlowRpcThresholdForTest,
  shouldTrackRpcAck,
  slowRpcRequests,
  slowRpcToast,
  trackRpcPromise,
  trackRpcRequestSent,
} from "./rpcLatency";

const until = async (ready: () => boolean) => { for (let attempt = 0; attempt < 400 && !ready(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10)); };

test("subscriptions, pull request polling and background reports are not tracked", () => {
  expect(shouldTrackRpcAck("orchestration.subscribeShell")).toBe(false);
  expect(shouldTrackRpcAck("pullRequests.list")).toBe(false);
  expect(shouldTrackRpcAck("server.getUsageSummary")).toBe(false);
  expect(shouldTrackRpcAck("server.reportClientActivity")).toBe(false);
  expect(shouldTrackRpcAck("sourceControl.signInWait")).toBe(false);
  expect(shouldTrackRpcAck("server.getConfig")).toBe(true);
});

test("updates and refreshes get the long threshold, the rest 15 seconds", () => {
  expect(rpcAckThresholdMs("server.getConfig")).toBe(SLOW_RPC_ACK_THRESHOLD_MS);
  expect(rpcAckThresholdMs("server.updateProvider")).toBe(LONG_RUNNING_RPC_ACK_THRESHOLD_MS);
  expect(rpcAckThresholdMs("vcs.refreshStatus")).toBe(LONG_RUNNING_RPC_ACK_THRESHOLD_MS);
});

test("the toast copy counts the requests and lists them behind Show requests", () => {
  const request = { requestId: "r1", startedAt: "2026-11-11T10:00:00.000Z", startedAtMs: 0, tag: "server.getConfig", thresholdMs: 15_000 };
  expect(describeSlowRequests([request])).toBe("1 request waiting longer than 15s.");
  expect(describeSlowRequests([request, { ...request, requestId: "r2", thresholdMs: 120_000 }])).toBe("2 requests waiting longer than 15s.");
  const toast = slowRpcToast([request]);
  expect(toast).toMatchObject({ id: SLOW_RPC_TOAST_ID, type: "warning", title: "Some requests are slow", timeoutMs: 0 });
  expect(toast.expandable.labels).toEqual({ expand: "Show requests", collapse: "Hide requests" });
  expect(toast.expandable.rows[0]!.title).toBe("server.getConfig");
});

test("a request that outlasts the threshold is listed, and answering it removes it", async () => {
  setSlowRpcThresholdForTest(30);
  try {
    let answer: (value: string) => void = () => undefined;
    const slow = trackRpcPromise("server.getConfig", new Promise<string>((resolve) => { answer = resolve; }));
    await until(() => slowRpcRequests().length === 1);
    expect(slowRpcRequests()[0]!.tag).toBe("server.getConfig");
    answer("done");
    await slow;
    await until(() => slowRpcRequests().length === 0);
    expect(slowRpcRequests().length).toBe(0);
    // An answer before the threshold never lists the request.
    const quick = trackRpcPromise("server.getConfig", Promise.resolve(1));
    await quick;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(slowRpcRequests().length).toBe(0);
    trackRpcRequestSent("manual", "server.getConfig");
    await until(() => slowRpcRequests().length === 1);
    acknowledgeRpcRequest("manual");
    expect(slowRpcRequests().length).toBe(0);
    clearToasts();
    expect(toastById(SLOW_RPC_TOAST_ID)).toBe(undefined);
  } finally {
    setSlowRpcThresholdForTest(SLOW_RPC_ACK_THRESHOLD_MS);
  }
});
