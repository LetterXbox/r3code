import { expect, test } from "nsh/test";
import { fetchThreadTranscript, setTranscriptFetchForTests, threadContextFileParts, transcriptImportFailure } from "./components/composer/threadTranscriptImport";

test("a dropped thread's transcript is read over HTTP and becomes the reference's .jsonl file", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  setTranscriptFetchForTests((async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, headers: init.headers });
    return { status: 200, json: async () => ({ threadId: "t1", title: "Fix: the/bug", updatedAt: "2026-11-13T00:00:00.000Z", items: [{ id: "a" }, { id: "b" }] }) };
  }) as unknown as typeof fetch);
  const transcript = await fetchThreadTranscript("ws://127.0.0.1:4000/ws", "tok", "t1");
  expect(seen[0].url).toBe("http://127.0.0.1:4000/api/orchestration/threads/t1/transcript");
  expect(seen[0].headers["x-t3-orchestration-protocol"]).toBe("2");
  const parts = threadContextFileParts("env-1", transcript);
  expect(parts.name.startsWith("Fix_ the_bug-")).toBe(true);
  expect(parts.name.endsWith(".jsonl")).toBe(true);
  const lines = parts.text.trim().split("\n");
  expect(lines.length).toBe(3);
  expect(JSON.parse(lines[0]).environmentId).toBe("env-1");
  expect(JSON.parse(lines[2])).toEqual({ id: "b" });
  setTranscriptFetchForTests((async () => ({ status: 400, json: async () => ({ reason: "thread_transcript_too_large" }) })) as unknown as typeof fetch);
  const failure = await fetchThreadTranscript("ws://h/ws", "tok", "t1").catch((error: unknown) => error);
  expect(transcriptImportFailure(failure)).toBe("This thread exceeds the attachment size limit. Try a shorter thread.");
  setTranscriptFetchForTests(null);
});
