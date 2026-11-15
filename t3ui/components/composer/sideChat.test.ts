import { expect, test } from "nsh/test";
import { startSideChat } from "./runCommands";
import type { SideChatCommands } from "./runCommands";

function recorder(log: string[]): SideChatCommands {
  return {
    fork: async (parent, target) => { log.push(`fork:${parent}>${target}`); },
    setRuntimeMode: async (thread, mode) => { log.push(`mode:${thread}:${mode}`); },
    send: async (thread, text) => { log.push(`send:${thread}:${text}`); },
  };
}

test("a side chat copies the parent's runtime mode before it sends the question", async () => {
  const log: string[] = [];
  let polls = 0;
  const id = await startSideChat({
    parentId: "thread:p", targetId: "thread:s", prompt: "why?", runtimeMode: "full-access", modelSelection: null,
    arrived: () => ++polls > 2, commands: recorder(log), wait: async () => {},
  });
  expect(id).toBe("thread:s");
  expect(log).toEqual(["fork:thread:p>thread:s", "mode:thread:s:full-access", "send:thread:s:why?"]);
});

test("a side chat that never reaches the client reports it and sends nothing", async () => {
  const log: string[] = [];
  let failure = "";
  try {
    await startSideChat({ parentId: "p", targetId: "s", prompt: "x", runtimeMode: "approval-required", modelSelection: null, arrived: () => false, commands: recorder(log), wait: async () => {} });
  } catch (error) { failure = String(error); }
  expect(failure).toContain("did not reach this client");
  expect(log).toEqual(["fork:p>s"]);
});

test("a side chat keeps a fork's matching mode, discards itself when a step fails, and allows one start at a time (useSideChat)", async () => {
  const log: string[] = [];
  const commands: SideChatCommands = { ...recorder(log), send: async () => { throw new Error(""); }, discard: async (thread) => { log.push(`discard:${thread}`); } };
  let failure = "";
  const pending = startSideChat({ parentId: "p", targetId: "s", prompt: "x", runtimeMode: "full-access", forkRuntimeMode: () => "full-access", modelSelection: null, arrived: () => true, commands, wait: async () => {} })
    .catch((error: unknown) => { failure = error instanceof Error ? error.message : String(error); });
  expect(await startSideChat({ parentId: "p", targetId: "t", prompt: "y", runtimeMode: null, modelSelection: null, arrived: () => true, commands: recorder(log), wait: async () => {} })).toBe(null);
  await pending;
  expect(failure).toBe("Could not send the side chat message.");
  expect(log).toEqual(["fork:p>s", "discard:s"]);
});

test("a side chat opened with no prompt copies the parent's model into its draft and sends nothing", async () => {
  const log: string[] = [];
  const commands: SideChatCommands = { ...recorder(log), setDraftModel: (thread, selection) => { log.push(`model:${thread}:${String(selection.instanceId)}/${String(selection.model)}`); } };
  await startSideChat({ parentId: "p", targetId: "s", prompt: "  ", runtimeMode: null, modelSelection: { instanceId: "codex", model: "gpt-5" }, arrived: () => true, commands, wait: async () => {} });
  expect(log).toEqual(["fork:p>s", "model:s:codex/gpt-5"]);
});
