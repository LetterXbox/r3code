import { expect, test } from "nsh/test";
import { attachConfirmDialogHost, confirmDialogState, respondToConfirmDialog } from "../toast/confirmDialog";
import { closeTerminalSession, confirmTerminalClose } from "./terminalCommands";

test("closing a terminal asks first, and only a confirmed close reaches the server", async () => {
  const detach = attachConfirmDialogHost();
  const calls: string[] = [];
  const rpc = async (method: string) => { calls.push(method); return null; };

  const cancelled = closeTerminalSession("key", "thread", "terminal-1", rpc as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const asking = confirmDialogState();
  expect(asking.status).toBe("confirming");
  if (asking.status !== "idle") {
    expect(asking.message.includes("This stops the running process and clears its history.")).toBe(true);
    expect(asking.message.startsWith("Close terminal \"")).toBe(true);
    expect(asking.variant).toBe("destructive");
  }
  respondToConfirmDialog(false);
  await cancelled;
  expect(calls).toEqual([]);

  const confirmed = closeTerminalSession("key", "thread", "terminal-1", rpc as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  respondToConfirmDialog(true);
  await confirmed;
  expect(calls).toEqual(["terminal.close"]);
  detach();
});

test("several terminals are named in one confirmation, and no dialog host means no question", async () => {
  expect(await confirmTerminalClose(["Terminal 1", "Terminal 2"])).toBe(true);
});

test("a failed close types exit into the session and reports no error", async () => {
  const detach = attachConfirmDialogHost();
  const calls: [string, unknown][] = [];
  const rpc = async (method: string, payload: unknown) => { calls.push([method, payload]); if (method === "terminal.close") throw new Error("refused"); return null; };
  const done = closeTerminalSession("key", "thread", "terminal-9", rpc as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  respondToConfirmDialog(true);
  expect(await done).toBe(null);
  expect(calls.map(([method]) => method)).toEqual(["terminal.close", "terminal.write"]);
  expect(calls[1]![1]).toEqual({ threadId: "thread", terminalId: "terminal-9", data: "exit\n" });
  detach();
});
